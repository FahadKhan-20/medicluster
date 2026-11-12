import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DockerHttpController,
  FakeDockerClient,
  RestartTracker,
  SelfhealLoop,
  registerSelfheal,
  resolveContainers,
  DEFAULT_CONTAINERS,
} from "../src/selfheal/index.js";
import { FakeJev, type Answer, type Question, type Decider } from "../src/judge/jev.js";
import { FakeLlm } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import { HealthPoller } from "../src/events/health.js";
import type { Event } from "../src/events/events.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = {
  threshold: 0.9,
  groups: { imaging: "auto", alerts: "auto", selfheal: "auto" },
  rateLimitPerMinute: 30,
} as const;

function jevSelfhealRules(action: "restart" | "wait" | "escalate", prob = 0.95, actNow = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const all = ["restart", "wait", "escalate"];
      const others = all.filter((a) => a !== action);
      const rest = (1 - prob) / others.length;
      return {
        type: "choice",
        choice: action,
        probabilities: { [action]: prob, ...Object.fromEntries(others.map((o) => [o, rest])) },
        confidence: prob,
      };
    }
    if (name === "urgency") {
      return { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } };
    }
    return { type: "noul", noul: actNow };
  };
}

function setupTest(opts: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  policy?: any;
  docker?: FakeDockerClient;
  now?: () => number;
  backendFails?: boolean;
  backendCall?: (method: string, path: string, body?: any) => Promise<any>;
  containers?: Record<string, string>;
} = {}) {
  const { rpc, db } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const gate = new Gate({ current: () => opts.policy ?? POLICY } as unknown as PolicyStore);

  const calls: { method: string; path: string; body?: any }[] = [];
  const backend = {
    async call(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (opts.backendCall) return opts.backendCall(method, path, body);
      if (opts.backendFails) return { ok: false as const, status: 503, error: "backend unreachable", retryable: true as const };
      return { ok: true as const, status: 200, data: { id: "alert-123" } };
    },
  };

  const docker =
    opts.docker ??
    new FakeDockerClient({
      "medicluster-backend-1": { status: "exited", running: false, exitCode: 1 },
      "medicluster-ml-engine-1": { status: "unhealthy", running: true, health: "unhealthy" },
    });

  const jev = opts.jev ?? new FakeJev(jevSelfhealRules("restart"));
  const llm = new FakeLlm(opts.llm ?? (() => ({ title: "Generated Alert", summary: "Generated Summary" })));

  const loop = new SelfhealLoop({
    docker,
    jev,
    llm,
    audit,
    state,
    gate,
    backend,
    containers: opts.containers,
    now: opts.now,
  });

  return { loop, docker, jev, llm, audit, state, gate, backend, calls, db, store };
}

describe("DockerHttpController", () => {
  it("inspects container and parses response on 200", async () => {
    const fakeRequest = async () => ({
      status: 200,
      data: JSON.stringify({
        Id: "c123",
        Name: "/test-container",
        State: { Status: "exited", Running: false, ExitCode: 137, Health: { Status: "unhealthy" } },
      }),
    });

    const controller = new DockerHttpController({ requestFn: fakeRequest });
    const result = await controller.inspect("test-container");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("c123");
    expect(result?.name).toBe("test-container");
    expect(result?.status).toBe("exited");
    expect(result?.running).toBe(false);
    expect(result?.exitCode).toBe(137);
    expect(result?.health).toBe("unhealthy");
  });

  it("returns null when container is 404", async () => {
    const fakeRequest = async () => ({ status: 404, data: '{"message":"no such container"}' });
    const controller = new DockerHttpController({ requestFn: fakeRequest });
    const result = await controller.inspect("nonexistent");
    expect(result).toBeNull();
  });

  it("throws on inspect unexpected error status", async () => {
    const fakeRequest = async () => ({ status: 500, data: "daemon failure" });
    const controller = new DockerHttpController({ requestFn: fakeRequest });
    await expect(controller.inspect("bad")).rejects.toThrow("Docker inspect failed with status 500");
  });

  it("restarts container on 204", async () => {
    const fakeRequest = async () => ({ status: 204, data: "" });
    const controller = new DockerHttpController({ requestFn: fakeRequest });
    const res = await controller.restart("test-container");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("returns error on restart 404", async () => {
    const fakeRequest = async () => ({ status: 404, data: "" });
    const controller = new DockerHttpController({ requestFn: fakeRequest });
    const res = await controller.restart("missing");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("handles network/timeout errors gracefully", async () => {
    const fakeRequest = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const controller = new DockerHttpController({ requestFn: fakeRequest });
    const res = await controller.restart("c1");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain("connect ENOENT");
  });

  it("talks to a real unix domain socket mock server", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockertest-"));
    const socketPath = path.join(socketDir, "docker.sock");

    const server = http.createServer((req, res) => {
      if (req.url === "/containers/my-srv/json" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: "sock-123", Name: "/my-srv", State: { Status: "running", Running: true } }));
        return;
      }
      if (req.url?.startsWith("/containers/my-srv/restart") && req.method === "POST") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const controller = new DockerHttpController({ socketPath });
      const inspect = await controller.inspect("my-srv");
      expect(inspect?.id).toBe("sock-123");
      expect(inspect?.running).toBe(true);

      const restart = await controller.restart("my-srv");
      expect(restart.ok).toBe(true);
      expect(restart.status).toBe(204);
    } finally {
      server.close();
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});

describe("RestartTracker", () => {
  it("tracks restarts and limits to 3 in 10 minutes", () => {
    let now = 1000;
    const tracker = new RestartTracker({ now: () => now });

    expect(tracker.canRestart("backend")).toBe(true);
    tracker.recordRestart("backend");
    expect(tracker.getRestarts("backend").length).toBe(1);

    now += 60_000;
    tracker.recordRestart("backend");
    expect(tracker.getRestarts("backend").length).toBe(2);

    now += 60_000;
    tracker.recordRestart("backend");
    expect(tracker.getRestarts("backend").length).toBe(3);

    // 4th restart is disallowed
    expect(tracker.canRestart("backend")).toBe(false);

    // Different service is independent
    expect(tracker.canRestart("ml")).toBe(true);

    // Advance 10 minutes from first restart (1000 + 10 * 60 * 1000 + 1 = 601001)
    now = 1000 + 10 * 60 * 1000 + 1;
    expect(tracker.canRestart("backend")).toBe(true);
    expect(tracker.getRestarts("backend").length).toBe(2);
  });
});

describe("Container mapping", () => {
  it("defaults to standard containers and parses SELFHEAL_CONTAINERS env", () => {
    expect(DEFAULT_CONTAINERS.backend).toBe("medicluster-backend-1");
    expect(DEFAULT_CONTAINERS.ml).toBe("medicluster-ml-engine-1");

    const custom = resolveContainers(undefined, JSON.stringify({ backend: "custom-backend-1", worker: "worker-1" }));
    expect(custom.backend).toBe("custom-backend-1");
    expect(custom.ml).toBe("medicluster-ml-engine-1");
    expect(custom.worker).toBe("worker-1");
  });
});

describe("SelfhealLoop", () => {
  it("executes container restart when Jev decides restart", async () => {
    const { loop, docker, db } = setupTest();

    const event: Event = {
      id: "backend:down:1",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("executed");

    expect(docker.restarts.length).toBe(1);
    expect(docker.restarts[0].container).toBe("medicluster-backend-1");

    // Verify audit steps
    const auditLogs = [...db.get("agent_audit")!.values()];
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].outcome).toBe("executed");
    expect(auditLogs[0].steps.some((s: any) => s.kind === "docker")).toBe(true);
    expect(auditLogs[0].steps.some((s: any) => s.kind === "gate")).toBe(true);
  });

  it("skips when Jev decides wait", async () => {
    const { loop, docker } = setupTest({
      jev: new FakeJev(jevSelfhealRules("wait")),
    });

    const event: Event = {
      id: "backend:down:wait",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("skipped");
    expect(docker.restarts.length).toBe(0);
  });

  it("escalates via alerts.create when Jev decides escalate", async () => {
    const { loop, docker, calls } = setupTest({
      jev: new FakeJev(jevSelfhealRules("escalate")),
    });

    const event: Event = {
      id: "backend:down:escalate",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("executed");
    expect(docker.restarts.length).toBe(0);

    // Verify alert was created via backend call
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/alerts/agent");
    expect(calls[0].body.patient_id).toBe("system");
    expect(calls[0].body.source_id).toBe("backend");
    expect(calls[0].body.severity).toBe("CRITICAL");
  });

  it("HARD RULE: forces escalation when 3 restarts occurred within 10 minutes", async () => {
    let now = 100_000;
    const { loop, docker, calls, db } = setupTest({
      now: () => now,
      jev: new FakeJev(jevSelfhealRules("restart")),
    });

    // Run 3 restarts
    for (let i = 1; i <= 3; i++) {
      const ev: Event = {
        id: `backend:down:${i}`,
        type: "service.down",
        service: "backend",
        at: new Date(now).toISOString(),
      };
      const res = await loop.handle(ev);
      expect(res).toBe("executed");
      now += 10_000;
    }

    expect(docker.restarts.length).toBe(3);
    expect(calls.length).toBe(0); // No alerts yet

    // 4th downtime occurs within 10 minutes
    const fourthEvent: Event = {
      id: "backend:down:4",
      type: "service.down",
      service: "backend",
      at: new Date(now).toISOString(),
    };

    const fourthOutcome = await loop.handle(fourthEvent);
    expect(fourthOutcome).toBe("executed"); // Escalation executed

    // Hard rule prevented restart: still exactly 3 restarts!
    expect(docker.restarts.length).toBe(3);

    // Hard rule forced escalation via alert
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/api/alerts/agent");
    expect(calls[0].body.source_id).toBe("backend");

    // Verify audit recorded hard_rule step
    const audits = [...db.get("agent_audit")!.values()];
    const fourthAudit = audits.find((a: any) => a.event.id === "backend:down:4");
    expect(fourthAudit.steps.some((s: any) => s.kind === "hard_rule")).toBe(true);
  });

  it("blocks and enqueues event when kill switch is active (state.isStopped)", async () => {
    const { loop, docker, state, db } = setupTest();
    await state.setStopped(true);

    const event: Event = {
      id: "backend:down:stopped",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("blocked");
    expect(docker.restarts.length).toBe(0);

    // Verify event was enqueued
    const queued = await state.drain();
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe(event.id);
  });

  it("redirects to escalate if Gate verdict is review (e.g. low confidence)", async () => {
    // Prob < 0.9 causes gate to return 'review'
    const { loop, docker, calls } = setupTest({
      jev: new FakeJev(jevSelfhealRules("restart", 0.7)),
    });

    const event: Event = {
      id: "backend:down:lowconf",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("executed"); // Escalated alert executed
    expect(docker.restarts.length).toBe(0); // Did not restart automatically
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/api/alerts/agent");
  });

  it("blocks when selfheal group is off in policy", async () => {
    const { loop, docker } = setupTest({
      policy: { threshold: 0.9, groups: { selfheal: "off" }, rateLimitPerMinute: 30 },
    });

    const event: Event = {
      id: "backend:down:off",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("blocked");
    expect(docker.restarts.length).toBe(0);
  });

  it("prevents duplicate execution of already-done action", async () => {
    const { loop, docker } = setupTest();

    const event: Event = {
      id: "backend:down:dupe",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const first = await loop.handle(event);
    expect(first).toBe("executed");
    expect(docker.restarts.length).toBe(1);

    const second = await loop.handle(event);
    expect(second).toBe("blocked");
    expect(docker.restarts.length).toBe(1); // No second restart
  });

  it("handles docker restart failure and returns failed outcome", async () => {
    const fakeDocker = new FakeDockerClient({
      "medicluster-backend-1": { status: "exited", running: false },
    });
    fakeDocker.failRestart("medicluster-backend-1");

    const { loop } = setupTest({ docker: fakeDocker });

    const event: Event = {
      id: "backend:down:fail",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("failed");
  });

  it("enqueues and returns pending when backend is unavailable during escalate", async () => {
    const { loop, state } = setupTest({
      jev: new FakeJev(jevSelfhealRules("escalate")),
      backendFails: true,
    });

    const event: Event = {
      id: "backend:down:pending",
      type: "service.down",
      service: "backend",
      at: "2026-11-13T00:00:00.000Z",
    };

    const outcome = await loop.handle(event);
    expect(outcome).toBe("pending");

    const queued = await state.drain();
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe(event.id);
  });

  it("handles container exited/unhealthy direct checks via checkContainer", async () => {
    const fakeDocker = new FakeDockerClient({
      "medicluster-backend-1": { status: "exited", running: false, exitCode: 1 },
    });
    const { loop } = setupTest({ docker: fakeDocker });

    const outcome = await loop.checkContainer("backend");
    expect(outcome).toBe("executed");
    expect(fakeDocker.restarts.length).toBe(1);
  });

  it("registerSelfheal wires HealthPoller service.down events directly to selfheal", async () => {
    const fakeDocker = new FakeDockerClient({
      "medicluster-backend-1": { status: "exited", running: false },
    });
    const { rpc } = fakeRpc();
    const store = new McStore(rpc);
    const audit = new Audit(store);
    const state = new AgentState(store);
    const gate = new Gate({ current: () => POLICY } as unknown as PolicyStore);
    const backend = {
      async call() {
        return { ok: true as const, status: 200, data: {} };
      },
    };
    const jev = new FakeJev(jevSelfhealRules("restart"));

    // HealthPoller with a target that returns 500 (down)
    const poller = new HealthPoller({
      targets: { backend: "http://backend.mock/health" },
      fetch: (async () => ({ ok: false, status: 500 })) as any,
    });

    registerSelfheal(poller, {
      docker: fakeDocker,
      jev,
      audit,
      state,
      gate,
      backend,
    });

    const eventsHandled: Event[] = [];
    await poller.start((e) => {
      eventsHandled.push(e);
    });
    poller.stop();

    // Verify health event was emitted
    expect(eventsHandled.length).toBe(1);
    expect(eventsHandled[0].type).toBe("service.down");

    // Wait microtask tick for async handle
    await new Promise((r) => setTimeout(r, 20));

    // Verify selfheal restarted the container
    expect(fakeDocker.restarts.length).toBe(1);
    expect(fakeDocker.restarts[0].container).toBe("medicluster-backend-1");
  });
});
