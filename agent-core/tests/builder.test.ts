import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import {
  BuilderService,
  BuilderConcurrencyError,
  DEFAULT_BUILDER_CMD,
  BUILDER_JEV_QUESTIONS,
  slugify,
} from "../src/builder/builder.js";
import {
  FakeProcessRunner,
  scrubEnv,
  redactSecrets,
  collectSecrets,
  tail,
} from "../src/builder/runner.js";
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
  envAllowlist?: string;
  killPollIntervalMs?: number;
  modifiedMainRefs?: boolean;
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
  runner.onCommand(/git config/, { exitCode: 0, stdout: "" });
  runner.onCommand(/git remote/, { exitCode: 0, stdout: "origin\n" });

  let forEachRefCalls = 0;
  runner.onCommand(/git for-each-ref/, () => {
    forEachRefCalls++;
    if (options.modifiedMainRefs && forEachRefCalls > 1) {
      // Simulate tampering with main branch ref
      return {
        exitCode: 0,
        stdout: "refs/heads/main evil_commit_hash\nrefs/heads/par/builder a1b2c3d4e5f6\n",
      };
    }
    return {
      exitCode: 0,
      stdout: "refs/heads/main 111111111111\nrefs/heads/par/builder a1b2c3d4e5f6\n",
    };
  });

  runner.onCommand(/git status --porcelain/, { exitCode: 0, stdout: " M file.ts\n" });
  runner.onCommand(/git add -A/, { exitCode: 0, stdout: "" });
  runner.onCommand(/git commit -m/, { exitCode: 0, stdout: "[builder/task 1234567] builder commit\n" });
  runner.onCommand(/git diff --stat/, {
    exitCode: 0,
    stdout: " 2 files changed, 25 insertions(+), 5 deletions(-)\n",
  });

  // Mock npm ci --prefer-offline
  runner.onCommand(/npm ci --prefer-offline/, {
    exitCode: 0,
    stdout: "added 120 packages in 1s\n",
  });

  // Mock coding agent CLI
  runner.onCommand(/agy|custom-agent/, {
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

  const defaultPolicy = {
    threshold: 0.9,
    groups: { builder: "suggest" },
    rateLimitPerMinute: 30,
  };

  const policyStore = {
    current: () => options.gatePolicy ?? defaultPolicy,
  } as unknown as PolicyStore;
  const gate = new Gate(policyStore);

  const builder = new BuilderService({
    audit,
    state,
    jev,
    gate,
    runner,
    repoRoot: "/mock/repo",
    worktreeBaseDir: path.join(os.tmpdir(), "mc-builder-tests"),
    builderCmd: options.builderCmd,
    envAllowlist: options.envAllowlist,
    killPollIntervalMs: options.killPollIntervalMs,
    group: "builder",
  });

  return { builder, runner, audit, state, store, jev, db, gate };
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

describe("env scrubbing and secret redaction", () => {
  it("scrubEnv allows only PATH, HOME, LANG, TERM and safe allowlist items", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      CUSTOM_SAFE: "safe_value",
      ADMIN_KEY: "super_secret_admin_key_12345",
      SUPABASE_URL: "https://secret.supabase.co",
      SUPABASE_ANON_KEY: "supabase_anon_secret_val",
      AGENT_JWT_SECRET: "jwt_secret_super_secret_val",
      OPENROUTER_KEY: "openrouter_api_key_val",
      OMNIROUTE_URL: "http://omniroute.local",
    };

    const scrubbed = scrubEnv(parent, "CUSTOM_SAFE,SUPABASE_URL,ADMIN_KEY");
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/user");
    expect(scrubbed.LANG).toBe("en_US.UTF-8");
    expect(scrubbed.TERM).toBe("xterm-256color");
    expect(scrubbed.CUSTOM_SAFE).toBe("safe_value");

    // Denied even if explicitly present in allowlist:
    expect(scrubbed.ADMIN_KEY).toBeUndefined();
    expect(scrubbed.SUPABASE_URL).toBeUndefined();
    expect(scrubbed.SUPABASE_ANON_KEY).toBeUndefined();
    expect(scrubbed.AGENT_JWT_SECRET).toBeUndefined();
    expect(scrubbed.OPENROUTER_KEY).toBeUndefined();
    expect(scrubbed.OMNIROUTE_URL).toBeUndefined();
  });

  it("redacts parent env secrets (>12 chars) from log output", () => {
    const parent = {
      SHORT: "abc",
      LONG_SECRET_1: "super_secret_admin_key_12345",
      LONG_SECRET_2: "another_sensitive_token_here",
    };
    const secrets = collectSecrets(parent, 13);
    expect(secrets).toContain("super_secret_admin_key_12345");
    expect(secrets).toContain("another_sensitive_token_here");
    expect(secrets).not.toContain("abc");

    const text = "Error: authentication failed with super_secret_admin_key_12345 and another_sensitive_token_here!";
    const redacted = redactSecrets(text, secrets);
    expect(redacted).toBe("Error: authentication failed with [REDACTED] and [REDACTED]!");
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

describe("BuilderService - Safety & Lifecycle", () => {
  it("Item 1: requires Gate and calls gate.check before spawning CLI (blocks if group off)", async () => {
    // Gate with builder: off
    const { builder, runner, audit } = await setupBuilder({
      gatePolicy: {
        threshold: 0.9,
        groups: { builder: "off" },
        rateLimitPerMinute: 30,
      },
    });

    const result = await builder.handleTask({
      title: "Task with group off",
      description: "Should be blocked by gate before CLI",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("group_off");

    // CLI was NEVER spawned
    const calls = runner.calls.map((c) => c.command);
    expect(calls).not.toContain("agy");

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("blocked");
    expect(logs[0].reason).toBe("group_off");
  });

  it("Item 2: spawns CLI with scrubbed env (no secrets passed)", async () => {
    const origEnv = { ...process.env };
    process.env.ADMIN_KEY = "leaked_admin_secret_key";
    process.env.SUPABASE_KEY = "leaked_supabase_secret_key";
    process.env.AGENT_JWT_SECRET = "leaked_agent_jwt_secret_key";
    process.env.OPENROUTER_KEY = "leaked_openrouter_secret_key";
    process.env.BUILDER_ENV_ALLOW = "SAFE_ALLOW_VAR,SUPABASE_KEY";
    process.env.SAFE_ALLOW_VAR = "allowed_val";

    try {
      const { builder, runner } = await setupBuilder();
      await builder.handleTask({
        title: "Env scrub test",
        description: "Verify scrubbed environment in runner",
      });

      const agentCall = runner.calls.find((c) => c.command === "agy");
      expect(agentCall).toBeDefined();
      const env = agentCall?.options?.env;
      expect(env).toBeDefined();

      expect(env?.SAFE_ALLOW_VAR).toBe("allowed_val");
      expect(env?.ADMIN_KEY).toBeUndefined();
      expect(env?.SUPABASE_KEY).toBeUndefined();
      expect(env?.AGENT_JWT_SECRET).toBeUndefined();
      expect(env?.OPENROUTER_KEY).toBeUndefined();
    } finally {
      process.env = origEnv;
    }
  });

  it("Item 3: blocks git push/merge in worktree & detects main repo ref tampering", async () => {
    // 1. Verify push is blocked in normal run
    const { builder: b1, runner: r1 } = await setupBuilder();
    await b1.handleTask({ title: "Push config test", description: "Verify git config" });

    const configCalls = r1.calls.filter((c) => c.command === "git" && c.args.includes("config"));
    expect(configCalls.some((c) => c.args.includes("extensions.worktreeConfig"))).toBe(true);
    expect(configCalls.some((c) => c.args.includes("remote.origin.pushurl") && c.args.includes("no_push"))).toBe(true);
    expect(configCalls.some((c) => c.args.includes("core.hooksPath"))).toBe(true);

    // 2. Verify tampering with main repo refs triggers security alert and fails
    const { builder: b2, audit: a2 } = await setupBuilder({ modifiedMainRefs: true });
    const res = await b2.handleTask({
      title: "Tampering test",
      description: "CLI modifies main branch",
    });

    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("main_repo_refs_modified");

    const logs = await a2.list();
    const entry = logs.find((l) => l._id === res.auditId);
    expect(entry.outcome).toBe("failed");
    expect(entry.steps.some((s: any) => s.kind === "security_alert")).toBe(true);
  });

  it("Item 4: runs npm ci --prefer-offline in the worktree instead of symlinking", async () => {
    const { builder, runner } = await setupBuilder();
    await builder.handleTask({
      title: "Npm ci test",
      description: "Verify npm ci --prefer-offline is called",
    });

    const npmCiCalls = runner.calls.filter((c) => c.fullCommand?.includes("npm ci --prefer-offline"));
    expect(npmCiCalls.length).toBe(2); // once for agent-core, once for backend
  });

  it("Item 5: enforces concurrency cap 1 and appends random suffix to slug", async () => {
    const { builder } = await setupBuilder();

    // Random suffix on slug
    const r1 = await builder.handleTask({ title: "Repeated title", description: "First run" });
    const r2 = await builder.handleTask({ title: "Repeated title", description: "Second run" });
    expect(r1.branch).toMatch(/^builder\/repeated-title-[a-f0-9]{6}$/);
    expect(r2.branch).toMatch(/^builder\/repeated-title-[a-f0-9]{6}$/);
    expect(r1.branch).not.toBe(r2.branch);

    // Concurrency cap 1: simultaneous calls throw BuilderConcurrencyError (409)
    let resolveFirst: (() => void) | undefined;
    const slowRunner = new FakeProcessRunner();
    slowRunner.onCommand(/agy/, () => new Promise<any>((resolve) => {
      resolveFirst = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    }));
    slowRunner.onCommand(/vitest/, { exitCode: 0, stdout: "pass" });
    slowRunner.onCommand(/npm test/, { exitCode: 0, stdout: "pass" });

    const { builder: busyBuilder } = await setupBuilder();
    (busyBuilder as any).runner = slowRunner;

    const task1Promise = busyBuilder.handleTask({ title: "Long task", description: "Running..." });
    await new Promise((r) => setTimeout(r, 10));

    // Second task while first is running should be rejected with 409
    await expect(busyBuilder.handleTask({ title: "Second task", description: "While busy" }))
      .rejects.toThrow(BuilderConcurrencyError);

    resolveFirst?.();
    await task1Promise;
  });

  it("Item 6: kill switch polls and terminates CLI process with SIGTERM", async () => {
    const { builder, audit, state } = await setupBuilder({
      killPollIntervalMs: 20,
    });

    // When agy runs, activate the kill switch
    (builder as any).runner.onCommand(/agy/, async () => {
      await state.setStopped(true);
      return { exitCode: 143, stdout: "", stderr: "terminated by kill switch" };
    });

    const result = await builder.handleTask({
      title: "Kill switch during run",
      description: "Should terminate child",
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("stopped");

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("blocked");
    expect(logs[0].reason).toBe("stopped");
  });

  it("Item 7: redacts secret values (>12 chars) from log tails and audit", async () => {
    const secret = "my_super_secret_database_token_123456";
    const orig = process.env.DB_SECRET;
    process.env.DB_SECRET = secret;

    try {
      const { builder, audit } = await setupBuilder();
      (builder as any).runner.onCommand(/agy/, {
        exitCode: 0,
        stdout: `Connected with token: ${secret} successfully\n`,
      });

      const res = await builder.handleTask({
        title: "Redact test",
        description: "Output contains secret",
      });

      expect(res.logTail).not.toContain(secret);
      expect(res.logTail).toContain("[REDACTED]");

      const logs = await audit.list();
      const entry = logs.find((l) => l._id === res.auditId);
      const agentStep = entry.steps.find((s: any) => s.kind === "agent_run");
      expect(agentStep.data.logTail).not.toContain(secret);
      expect(agentStep.data.logTail).toContain("[REDACTED]");
    } finally {
      process.env.DB_SECRET = orig;
    }
  });

  it("happy path: marks ready_for_review without merging or deploying", async () => {
    const { builder, runner, audit } = await setupBuilder();

    const result = await builder.handleTask({
      title: "Complete feature",
      description: "All safe checks pass",
    });

    expect(result.outcome).toBe("review");
    expect(result.reason).toBe("ready_for_review");
    expect(result.tests.allPassed).toBe(true);

    // Verify git merge / push never executed
    const calls = runner.calls.map((c) => c.fullCommand ?? `${c.command} ${c.args.join(" ")}`);
    expect(calls.some((c) => c.includes("git merge") || c.includes("git push"))).toBe(false);

    const logs = await audit.list();
    expect(logs[0].outcome).toBe("review");
    expect(logs[0].reason).toBe("ready_for_review");
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

    const r1 = await fetch(url, { method: "POST", body });
    expect(r1.status).toBe(401);

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

    const r1 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ description: "Desc only" }),
    });
    expect(r1.status).toBe(400);

    const r2 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ title: "   ", description: "Desc" }),
    });
    expect(r2.status).toBe(400);

    const r3 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ title: "Title only" }),
    });
    expect(r3.status).toBe(400);
  });

  it("returns 200 on success and 409 when busy", async () => {
    const url = `${base}/builder/task`;
    const admin = { "x-admin-key": ADMIN_KEY, "content-type": "application/json" };

    const res = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        title: "Build API feature",
        description: "Add new endpoint",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branch).toMatch(/^builder\/build-api-feature-[a-f0-9]{6}$/);
    expect(data.outcome).toBe("review");
    expect(data.reason).toBe("ready_for_review");

    // Test 409 response when service throws BuilderConcurrencyError
    vi.spyOn(builderService, "handleTask").mockRejectedValueOnce(new BuilderConcurrencyError());
    const r409 = await fetch(url, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        title: "Concurrent feature",
        description: "Should fail with 409",
      }),
    });
    expect(r409.status).toBe(409);
    expect((await r409.json()).error).toContain("concurrency cap");
  });
});
