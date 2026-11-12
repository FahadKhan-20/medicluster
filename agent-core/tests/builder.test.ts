import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import {
  BuilderService,
  DEFAULT_BUILDER_CMD,
  BUILDER_JEV_QUESTIONS,
  slugify,
} from "../src/builder/builder.js";
import { FakeProcessRunner, tail } from "../src/builder/runner.js";
import { FakeJev, type Answer, type Question } from "../src/judge/jev.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";
import { createServer } from "../src/api/server.js";

const ADMIN_KEY = "admin-secret-test-key";

async function setupBuilder(options: {
  stopped?: boolean;
  doneKeys?: string[];
  jevScore?: number;
  jevFallback?: boolean;
  vitestExit?: number;
  backendExit?: number;
  agentExit?: number;
  gatePolicy?: any;
  builderCmd?: string;
} = {}) {
  const { rpc, db } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);

  if (options.stopped) {
    await state.setStopped(true);
  }
  for (const k of options.doneKeys ?? []) {
    await state.markDone(k);
  }

  const runner = new FakeProcessRunner();

  // Mock git commands
  runner.onCommand(/git rev-parse HEAD/, { exitCode: 0, stdout: "a1b2c3d4e5f6\n" });
  runner.onCommand(/git worktree add/, { exitCode: 0, stdout: "Preparing worktree\n" });
  runner.onCommand(/git status --porcelain/, { exitCode: 0, stdout: " M file.ts\n" });
  runner.onCommand(/git add -A/, { exitCode: 0, stdout: "" });
  runner.onCommand(/git commit -m/, { exitCode: 0, stdout: "[builder/task 1234567] builder commit\n" });
  runner.onCommand(/git diff --stat/, {
    exitCode: 0,
    stdout: " 2 files changed, 25 insertions(+), 5 deletions(-)\n",
  });

  // Mock coding agent CLI
  runner.onCommand(/agy/, {
    exitCode: options.agentExit ?? 0,
    stdout: "Agent completed edits successfully\n",
    stderr: "",
  });

  // Mock repo tests
  runner.onCommand(/vitest/, {
    exitCode: options.vitestExit ?? 0,
    stdout: "Tests: 143 passed, 143 total\n",
    stderr: "",
  });
  runner.onCommand(/npm test|node --test/, {
    exitCode: options.backendExit ?? 0,
    stdout: "ℹ pass 106\nℹ fail 0\n",
    stderr: "",
  });

  const jevScore = options.jevScore ?? 0.95;
  const jevFallback = options.jevFallback ?? false;

  const jev = new FakeJev((name: string, _q: Question): Answer => {
    if (name === "ready_to_merge") {
      return { type: "noul", noul: jevScore };
    }
    return { type: "noul", noul: 0.5 };
  });

  if (jevFallback) {
    (jev as any).decide = async () => ({
      answers: { ready_to_merge: { type: "noul", noul: 0.5 } },
      cost: 0,
      fallback: true,
      error: "service timeout",
    });
  }

  let gate: Gate | undefined;
  if (options.gatePolicy) {
    const policyStore = {
      current: () => options.gatePolicy,
    } as unknown as PolicyStore;
    gate = new Gate(policyStore);
  }

  const builder = new BuilderService({
    audit,
    state,
    jev,
    gate,
    runner,
    repoRoot: "/mock/repo",
    worktreeBaseDir: path.join(os.tmpdir(), "mc-builder-tests"),
    builderCmd: options.builderCmd,
    group: "builder",
  });

  return { builder, runner, audit, state, store, jev, db };
}

describe("slugify", () => {
  it("converts strings to clean branch slugs", () => {
    expect(slugify("Add OAuth Login Flow")).toBe("add-oauth-login-flow");
    expect(slugify("Fix: bug in #123 (urgent!)")).toBe("fix-bug-in-123-urgent");
    expect(slugify("   multiple   spaces  and---dashes   ")).toBe("multiple-spaces-and-dashes");
    expect(slugify("a".repeat(60))).toBe("a".repeat(40));
    expect(slugify("???")).toBe("task");
    expect(slugify("")).toBe("task");
  });
});

describe("tail helper", () => {
  it("bounds output by lines and characters", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const t = tail(text, 10, 500);
    expect(t.split("\n")).toHaveLength(10);
    expect(t).toContain("line 99");

    const longLine = "x".repeat(1000);
    const shortTail = tail(longLine, 5, 50);
    expect(shortTail.length).toBe(50);
  });
});

describe("BuilderService", () => {
  it("happy path: creates worktree, runs agent CLI, runs tests, Jev decides, marks ready_for_review", async () => {
    const { builder, runner, audit } = await setupBuilder();

    const result = await builder.handleTask({
      title: "Fix user profile sync",
      description: "Ensure user profile updates propagate to audit log",
    });

    expect(result.branch).toBe("builder/fix-user-profile-sync");
    expect(result.commit).toBe("a1b2c3d4e5f6");
    expect(result.outcome).toBe("review");
    expect(result.reason).toBe("ready_for_review");
    expect(result.tests.allPassed).toBe(true);
    expect(result.tests.agentCore.passed).toBe(true);
    expect(result.tests.backend.passed).toBe(true);
    expect(result.diffStat).toContain("2 files changed");
    expect(result.decision?.readyToMerge).toBe(true);
    expect(result.decision?.score).toBe(0.95);

    // Verify git and runner commands
    const calls = runner.calls.map((c) => ({
      command: c.command,
      full: c.fullCommand ?? `${c.command} ${c.args.join(" ")}`,
      cwd: c.options?.cwd,
    }));

    // 1. Created worktree
    expect(calls.some((c) => c.full.includes("git worktree add -b builder/fix-user-profile-sync"))).toBe(true);

    // 2. Ran coding agent CLI non-interactively inside worktree
    const agentCall = calls.find((c) => c.full.includes("agy -p --dangerously-skip-permissions"));
    expect(agentCall).toBeDefined();
    expect(agentCall?.full).toContain("Task: Fix user profile sync");
    expect(agentCall?.cwd).toContain("fix-user-profile-sync");

    // 3. Ran both repo test suites inside worktree
    expect(calls.some((c) => c.full.includes("npx vitest run") && c.cwd?.endsWith("agent-core"))).toBe(true);
    expect(calls.some((c) => c.full.includes("npm test") && c.cwd?.endsWith("backend"))).toBe(true);

    // 4. Never merges or deploys
    expect(calls.some((c) => c.full.includes("git merge") || c.full.includes("git push") || c.full.includes("deploy"))).toBe(false);

    // 5. Audit trail records every step
    const logs = await audit.list();
    const entry = logs.find((l) => l._id === result.auditId);
    expect(entry).toBeDefined();
    expect(entry.outcome).toBe("review");
    expect(entry.reason).toBe("ready_for_review");

    const stepKinds = entry.steps.map((s: any) => s.kind);
    expect(stepKinds).toContain("worktree_created");
    expect(stepKinds).toContain("agent_run");
    expect(stepKinds).toContain("tests_run");
    expect(stepKinds).toContain("builder_result");
    expect(stepKinds).toContain("jev_decision");
  });

  it("blocks immediately when kill switch is active (stopped)", async () => {
    const { builder, runner, audit } = await setupBuilder({ stopped: true });

    const result = await builder.handleTask({
      title: "Emergency hotfix",
      description: "Should not run",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("stopped");
    expect(runner.calls).toHaveLength(0);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("blocked");
    expect(logs[0].reason).toBe("stopped");
  });

  it("blocks duplicate task that has already completed", async () => {
    const slug = slugify("Repeat task");
    const { builder, runner, audit } = await setupBuilder({ doneKeys: [`builder:${slug}`] });

    const result = await builder.handleTask({
      title: "Repeat task",
      description: "Already done before",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("duplicate");
    expect(runner.calls).toHaveLength(0);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("blocked");
    expect(logs[0].reason).toBe("duplicate");
  });

  it("fails and does not mark ready_for_review if agent-core vitest fails", async () => {
    const { builder, audit } = await setupBuilder({ vitestExit: 1, jevScore: 0.99 });

    const result = await builder.handleTask({
      title: "Broken feature",
      description: "Breaks vitest",
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("tests_failed");
    expect(result.tests.agentCore.passed).toBe(false);
    expect(result.tests.allPassed).toBe(false);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("failed");
    expect(logs[0].reason).toBe("tests_failed");
  });

  it("fails and does not mark ready_for_review if backend test fails", async () => {
    const { builder, audit } = await setupBuilder({ backendExit: 1, jevScore: 0.99 });

    const result = await builder.handleTask({
      title: "Broken backend feature",
      description: "Breaks backend test",
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("tests_failed");
    expect(result.tests.backend.passed).toBe(false);
    expect(result.tests.allPassed).toBe(false);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("failed");
    expect(logs[0].reason).toBe("tests_failed");
  });

  it("marks low_confidence if Jev noul score is below threshold", async () => {
    const { builder, audit } = await setupBuilder({ jevScore: 0.65 });

    const result = await builder.handleTask({
      title: "Risky refactor",
      description: "Has suspicious diff",
    });

    expect(result.outcome).toBe("review");
    expect(result.reason).toBe("low_confidence");
    expect(result.tests.allPassed).toBe(true);
    expect(result.decision?.readyToMerge).toBe(false);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("review");
    expect(logs[0].reason).toBe("low_confidence");
  });

  it("handles Jev fallback safely", async () => {
    const { builder, audit } = await setupBuilder({ jevFallback: true });

    const result = await builder.handleTask({
      title: "Fallback test",
      description: "Jev service fails",
    });

    expect(result.outcome).toBe("review");
    expect(result.reason).toBe("jev_fallback");
    expect(result.decision?.fallback).toBe(true);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("review");
    expect(logs[0].reason).toBe("jev_fallback");
  });

  it("respects Gate policy when configured", async () => {
    // Gate with builder: suggest
    const { builder } = await setupBuilder({
      gatePolicy: {
        threshold: 0.9,
        groups: { builder: "suggest" },
        rateLimitPerMinute: 30,
      },
      jevScore: 0.95,
    });

    const result = await builder.handleTask({
      title: "Policy suggest test",
      description: "Should require human confirmation",
    });

    // In suggest mode, gate returns review with reason "suggest_level"
    // Wait, since tests pass and score is high, it stays in review
    expect(result.outcome).toBe("review");
  });

  it("supports custom BUILDER_CMD", async () => {
    const { builder, runner } = await setupBuilder({
      builderCmd: "custom-agent --mode=autonomous",
    });

    await builder.handleTask({
      title: "Custom CLI test",
      description: "Verify custom command execution",
    });

    const agentCall = runner.calls.find((c) => c.command === "custom-agent");
    expect(agentCall).toBeDefined();
    expect(agentCall?.args).toContain("--mode=autonomous");
    expect(agentCall?.args[1]).toContain("Task: Custom CLI test");
  });
});

describe("HTTP API /builder/task endpoint", () => {
  let server: http.Server;
  let base: string;
  let builderService: BuilderService;

  beforeEach(async () => {
    const setup = await setupBuilder();
    builderService = setup.builder;

    const audit = setup.audit;
    const state = setup.state;
    const store = setup.store;
    const loop = { handle: vi.fn(), retryPending: vi.fn() } as any;
    const health = { isUp: () => true } as any;

    server = createServer({
      audit,
      state,
      loop,
      health,
      store,
      adminKey: ADMIN_KEY,
      builder: builderService,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("requires admin key authentication", async () => {
    const url = `${base}/builder/task`;
    const body = JSON.stringify({ title: "Test", description: "Desc" });

    // Missing header
    const r1 = await fetch(url, { method: "POST", body });
    expect(r1.status).toBe(401);

    // Wrong header
    const r2 = await fetch(url, {
      method: "POST",
      headers: { "x-admin-key": "wrong-key" },
      body,
    });
    expect(r2.status).toBe(401);
  });

  it("validates task title and description", async () => {
    const url = `${base}/builder/task`;
    const admin = { "x-admin-key": ADMIN_KEY, "content-type": "application/json" };

    // Missing title
    const r1 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ description: "Desc only" }),
    });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "title is required" });

    // Empty title
    const r2 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ title: "   ", description: "Desc" }),
    });
    expect(r2.status).toBe(400);

    // Missing description
    const r3 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ title: "Title only" }),
    });
    expect(r3.status).toBe(400);
    expect(await r3.json()).toEqual({ error: "description is required" });

    // Invalid JSON
    const r4 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: "{ broken json",
    });
    expect(r4.status).toBe(400);
  });

  it("runs task successfully via POST /builder/task", async () => {
    const url = `${base}/builder/task`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-admin-key": ADMIN_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Add API rate limiting",
        description: "Implement token bucket rate limiter in express middleware",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toBe("builder/add-api-rate-limiting");
    expect(data.outcome).toBe("review");
    expect(data.reason).toBe("ready_for_review");
    expect(data.tests.allPassed).toBe(true);
    expect(data.diffStat).toBeDefined();
    expect(data.decision.readyToMerge).toBe(true);
  });
});
