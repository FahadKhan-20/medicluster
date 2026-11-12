import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import { noul, type Decider } from "../judge/jev.js";
import { GitClient } from "./git.js";
import {
  collectSecrets,
  NodeProcessRunner,
  redactSecrets,
  scrubEnv,
  splitArgs,
  tail,
} from "./runner.js";
import type {
  BuilderResult,
  BuilderTask,
  ProcessRunner,
  TestResultSummary,
} from "./types.js";

export const DEFAULT_BUILDER_CMD = "agy -p --dangerously-skip-permissions";
export const DEFAULT_VITEST_CMD = "npx vitest run";
export const DEFAULT_BACKEND_TEST_CMD = "npm test";

export const BUILDER_JEV_QUESTIONS = {
  ready_to_merge: noul(
    "The changes pass all repo tests, have a clean diff, and are safe and ready to merge into main"
  ),
};

export class BuilderConcurrencyError extends Error {
  readonly status = 409;
  constructor(message = "Builder service is currently busy (concurrency cap: 1)") {
    super(message);
    this.name = "BuilderConcurrencyError";
  }
}

export function slugify(title: string): string {
  const sanitized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return sanitized || "task";
}

function findRepoRoot(start = process.cwd()): string {
  let curr = path.resolve(start);
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, ".git"))) return curr;
    curr = path.dirname(curr);
  }
  return process.cwd();
}

export interface BuilderDeps {
  audit: Pick<Audit, "start" | "append" | "finish">;
  state: Pick<AgentState, "isStopped" | "isDone" | "markDone">;
  jev: Decider;
  gate: Pick<Gate, "check" | "record">; // Required gate
  runner?: ProcessRunner;
  repoRoot?: string;
  worktreeBaseDir?: string;
  builderCmd?: string;
  vitestCmd?: string;
  backendTestCmd?: string;
  threshold?: number;
  group?: string;
  envAllowlist?: string;
  killPollIntervalMs?: number;
}

export class BuilderService {
  private static isRunning = false;
  private static activeSlugs = new Set<string>();

  private readonly runner: ProcessRunner;
  private readonly git: GitClient;
  private readonly repoRoot: string;
  private readonly worktreeBaseDir: string;
  private readonly builderCmd: string;
  private readonly vitestCmd: string;
  private readonly backendTestCmd: string;
  private readonly threshold: number;
  private readonly group: string;
  private readonly envAllowlist?: string;
  private readonly killPollIntervalMs: number;

  constructor(private readonly deps: BuilderDeps) {
    if (!deps.gate) {
      throw new Error("Gate is required for BuilderService");
    }
    this.runner = deps.runner ?? new NodeProcessRunner();
    this.git = new GitClient(this.runner);
    this.repoRoot = deps.repoRoot ?? findRepoRoot();
    this.worktreeBaseDir =
      deps.worktreeBaseDir ??
      process.env.BUILDER_WORKTREE_DIR ??
      path.join(os.tmpdir(), "mc-builder");
    this.builderCmd =
      deps.builderCmd ?? process.env.BUILDER_CMD ?? DEFAULT_BUILDER_CMD;
    this.vitestCmd =
      deps.vitestCmd ?? process.env.BUILDER_VITEST_CMD ?? DEFAULT_VITEST_CMD;
    this.backendTestCmd =
      deps.backendTestCmd ??
      process.env.BUILDER_BACKEND_TEST_CMD ??
      DEFAULT_BACKEND_TEST_CMD;
    this.threshold = deps.threshold ?? 0.9;
    this.group = deps.group ?? "builder";
    this.envAllowlist = deps.envAllowlist;
    this.killPollIntervalMs = deps.killPollIntervalMs ?? 5000;
  }

  async handleTask(task: BuilderTask): Promise<BuilderResult> {
    const baseSlug = slugify(task.title);

    // Item 5: Concurrency cap 1 + per-slug lock (reject with 409 if busy)
    if (BuilderService.isRunning || BuilderService.activeSlugs.has(baseSlug)) {
      throw new BuilderConcurrencyError();
    }
    BuilderService.isRunning = true;
    BuilderService.activeSlugs.add(baseSlug);

    try {
      return await this.executeTask(task, baseSlug);
    } finally {
      BuilderService.isRunning = false;
      BuilderService.activeSlugs.delete(baseSlug);
    }
  }

  private async executeTask(task: BuilderTask, baseSlug: string): Promise<BuilderResult> {
    // Item 5: Append a short random suffix to the slug so repeated titles never reuse a worktree
    const randomSuffix = crypto.randomBytes(3).toString("hex");
    const slug = `${baseSlug}-${randomSuffix}`;
    const branch = `builder/${slug}`;
    const key = `builder:${slug}`;

    const emptyTests: {
      agentCore: TestResultSummary;
      backend: TestResultSummary;
      allPassed: boolean;
    } = {
      agentCore: { passed: false, exitCode: 1, logTail: "" },
      backend: { passed: false, exitCode: 1, logTail: "" },
      allPassed: false,
    };

    // Item 7: Redact secrets (>12 chars)
    const secrets = collectSecrets(process.env, 13);
    const redact = (text: string) => redactSecrets(text, secrets);

    // 1. Initial kill-switch check
    if (await this.deps.state.isStopped()) {
      const auditId = await this.deps.audit.start({
        type: "builder.task",
        title: task.title,
        description: task.description,
        branch,
      });
      await this.deps.audit.finish(auditId, "blocked", "stopped");
      return {
        auditId,
        branch,
        commit: "",
        outcome: "blocked",
        reason: "stopped",
        tests: emptyTests,
        diffStat: "",
        logTail: redact("kill switch is active (stopped)"),
      };
    }

    // 2. Initial duplicate check
    if (await this.deps.state.isDone(key)) {
      const auditId = await this.deps.audit.start({
        type: "builder.task",
        title: task.title,
        description: task.description,
        branch,
      });
      await this.deps.audit.finish(auditId, "blocked", "duplicate");
      return {
        auditId,
        branch,
        commit: "",
        outcome: "blocked",
        reason: "duplicate",
        tests: emptyTests,
        diffStat: "",
        logTail: redact("task already completed"),
      };
    }

    // 3. Start audit log
    const auditId = await this.deps.audit.start({
      type: "builder.task",
      title: task.title,
      description: task.description,
      branch,
    });

    const step = (kind: string, data: object) =>
      this.deps.audit.append(auditId, { kind, data });

    let worktreeDir = "";
    try {
      // 4. Create git worktree
      try {
        fs.mkdirSync(this.worktreeBaseDir, { recursive: true });
      } catch {
        // Best-effort directory creation
      }
      worktreeDir = path.join(this.worktreeBaseDir, slug);

      await this.git.createWorktree(this.repoRoot, branch, worktreeDir, "HEAD");
      const baseCommit = await this.git.getHeadCommit(worktreeDir);

      await step("worktree_created", { branch, worktreeDir, baseCommit });

      // Item 3: Configure worktree security (block push/merge and disable hooks)
      await this.git.configureWorktreeSecurity(worktreeDir);
      await step("worktree_secured", {
        pushBlocked: true,
        emptyHooks: true,
      });

      // Item 3: Snapshot main repo's HEAD and branch refs before running CLI
      const mainHeadBefore = await this.git.getHeadCommit(this.repoRoot);
      const mainRefsBefore = await this.git.getBranchRefs(this.repoRoot);

      // Item 4: Run `npm ci --prefer-offline` in the worktree instead of symlinking
      const npmCiAgent = await this.runner.runCommand("npm ci --prefer-offline", {
        cwd: path.join(worktreeDir, "agent-core"),
      });
      const npmCiBackend = await this.runner.runCommand("npm ci --prefer-offline", {
        cwd: path.join(worktreeDir, "medicluster", "backend"),
      });
      await step("dependencies_installed", {
        agentCore: { exitCode: npmCiAgent.exitCode },
        backend: { exitCode: npmCiBackend.exitCode },
      });

      // Item 1: Call gate.check (group "builder") and require a non-blocked verdict BEFORE spawning the CLI
      const preVerdict = this.deps.gate.check({
        group: this.group,
        action: "spawn_agent",
        actionProb: 1.0,
        actNow: 1.0,
        fallback: false,
        stopped: await this.deps.state.isStopped(),
        key: `builder:${slug}:spawn`,
        done: false,
      });
      await step("pre_gate", { key: `builder:${slug}:spawn`, ...preVerdict });
      if (preVerdict.verdict === "blocked") {
        await this.deps.audit.finish(auditId, "blocked", preVerdict.reason);
        return {
          auditId,
          branch,
          commit: baseCommit,
          outcome: "blocked",
          reason: preVerdict.reason,
          tests: emptyTests,
          diffStat: "",
          logTail: redact(`gate blocked before spawning CLI: ${preVerdict.reason}`),
        };
      }

      // Re-check kill switch before executing CLI
      if (await this.deps.state.isStopped()) {
        await this.deps.audit.finish(auditId, "blocked", "stopped");
        return {
          auditId,
          branch,
          commit: baseCommit,
          outcome: "blocked",
          reason: "stopped",
          tests: emptyTests,
          diffStat: "",
          logTail: redact("kill switch activated before agent execution"),
        };
      }

      // Item 2: Spawn CLI with scrubbed env (only PATH, HOME, LANG, TERM + allowlist, never keys/secrets)
      const scrubbedEnv = scrubEnv(process.env, this.envAllowlist);

      // 6. Run coding agent CLI non-interactively inside the worktree with kill-switch polling
      const taskText = `Task: ${task.title}\n\n${task.description}`;
      const [cmdExe, ...cmdArgs] = splitArgs(this.builderCmd);

      // Item 6: Kill switch: poll every 5s while the child runs; SIGTERM it when stopped
      const agentRes = await this.runner.run(
        cmdExe,
        [...cmdArgs, taskText],
        {
          cwd: worktreeDir,
          env: scrubbedEnv,
          isStopped: () => this.deps.state.isStopped(),
          pollIntervalMs: this.killPollIntervalMs,
        }
      );

      // Check if child was killed by kill switch
      if (await this.deps.state.isStopped() || agentRes.exitCode === 143) {
        await this.deps.audit.finish(auditId, "blocked", "stopped");
        return {
          auditId,
          branch,
          commit: baseCommit,
          outcome: "blocked",
          reason: "stopped",
          tests: emptyTests,
          diffStat: "",
          logTail: redact("process terminated by kill switch"),
        };
      }

      const agentTail = redact(tail(agentRes.stdout + "\n" + agentRes.stderr));
      await step("agent_run", {
        cmd: this.builderCmd,
        exitCode: agentRes.exitCode,
        durationMs: agentRes.durationMs,
        logTail: agentTail,
      });

      // Item 3: After the CLI finishes, verify the main repo's HEAD and branch refs other than builder/<slug> are unchanged
      const refCheck = await this.git.verifyMainRepoRefs(
        mainHeadBefore,
        mainRefsBefore,
        this.repoRoot,
        branch
      );
      if (!refCheck.ok) {
        await step("security_alert", {
          alert: "main_repo_refs_modified",
          reason: refCheck.reason,
          details: refCheck.details,
        });
        await this.deps.audit.finish(auditId, "failed", "main_repo_refs_modified");
        return {
          auditId,
          branch,
          commit: baseCommit,
          outcome: "failed",
          reason: "main_repo_refs_modified",
          tests: emptyTests,
          diffStat: "",
          logTail: redact(`Security Alert: main repo refs were modified by CLI (${refCheck.reason})`),
        };
      }

      // 7. Ensure changes are committed and inspect HEAD commit and diff
      await this.git.ensureCommitted(worktreeDir, `builder: ${task.title}`);
      const currentCommit = await this.git.getHeadCommit(worktreeDir);
      const rawDiffStat = await this.git.getDiffStat(worktreeDir, baseCommit);
      const diffStat = redact(rawDiffStat);

      // 8. Run repo tests (agent-core vitest + backend node --test)
      const agentCoreDir = path.join(worktreeDir, "agent-core");
      const backendDir = path.join(worktreeDir, "medicluster", "backend");

      const vitestRes = await this.runner.runCommand(this.vitestCmd, {
        cwd: agentCoreDir,
      });
      const backendRes = await this.runner.runCommand(this.backendTestCmd, {
        cwd: backendDir,
      });

      const vitestPassed = vitestRes.exitCode === 0;
      const backendPassed = backendRes.exitCode === 0;
      const allPassed = vitestPassed && backendPassed;

      // Item 7: Redact secrets from all log tails
      const vitestTail = redact(tail(vitestRes.stdout + "\n" + vitestRes.stderr));
      const backendTail = redact(tail(backendRes.stdout + "\n" + backendRes.stderr));
      const combinedLogTail = redact(
        tail(
          `[agent CLI - exit ${agentRes.exitCode}]\n${agentTail}\n\n[agent-core vitest - exit ${vitestRes.exitCode}]\n${vitestTail}\n\n[backend node --test - exit ${backendRes.exitCode}]\n${backendTail}`
        )
      );

      const tests = {
        agentCore: {
          passed: vitestPassed,
          exitCode: vitestRes.exitCode,
          logTail: vitestTail,
        },
        backend: {
          passed: backendPassed,
          exitCode: backendRes.exitCode,
          logTail: backendTail,
        },
        allPassed,
      };

      await step("tests_run", {
        vitest: { passed: vitestPassed, exitCode: vitestRes.exitCode, logTail: vitestTail },
        backend: { passed: backendPassed, exitCode: backendRes.exitCode, logTail: backendTail },
        allPassed,
      });

      // 9. Record result in audit log
      await step("builder_result", {
        branch,
        commit: currentCommit,
        testsPass: allPassed,
        diffStat,
        logTail: combinedLogTail,
      });

      // 10. Jev decides via noul whether change is ready to merge
      const jevState = {
        task: { title: task.title, description: task.description },
        branch,
        commit: currentCommit,
        diffStat,
        testResults: {
          allPassed,
          agentCore: { passed: vitestPassed, exitCode: vitestRes.exitCode, logTail: vitestTail },
          backend: { passed: backendPassed, exitCode: backendRes.exitCode, logTail: backendTail },
        },
      };

      const decision = await this.deps.jev.decide(
        jevState,
        BUILDER_JEV_QUESTIONS,
        "builder"
      );
      const readyScore = decision.answers.ready_to_merge?.noul ?? 0;

      await step("jev_decision", {
        answers: decision.answers,
        fallback: decision.fallback,
        cost: decision.cost,
        error: decision.error,
      });

      // 11. Kill switch recheck before write/finalize
      if (await this.deps.state.isStopped()) {
        await this.deps.audit.finish(auditId, "blocked", "stopped");
        return {
          auditId,
          branch,
          commit: currentCommit,
          outcome: "blocked",
          reason: "stopped",
          tests,
          diffStat,
          logTail: combinedLogTail,
          decision: {
            readyToMerge: false,
            score: readyScore,
            fallback: decision.fallback,
            cost: decision.cost,
            error: decision.error,
          },
        };
      }

      // 12. Gate safety check after decision
      const done = await this.deps.state.isDone(key);
      const stopped = await this.deps.state.isStopped();
      const verdict = this.deps.gate.check({
        group: this.group,
        action: "ready_for_review",
        actionProb: readyScore,
        actNow: readyScore,
        fallback: decision.fallback || !!decision.error,
        stopped,
        key,
        done,
      });

      await step("gate", { key, ...verdict });

      if (verdict.verdict === "blocked") {
        await this.deps.audit.finish(auditId, "blocked", verdict.reason);
        return {
          auditId,
          branch,
          commit: currentCommit,
          outcome: "blocked",
          reason: verdict.reason,
          tests,
          diffStat,
          logTail: combinedLogTail,
          decision: {
            readyToMerge: false,
            score: readyScore,
            fallback: decision.fallback,
            cost: decision.cost,
            error: decision.error,
          },
        };
      }

      // 13. Safety enforcement: if tests failed, never mark ready_for_review
      if (!allPassed) {
        await this.deps.audit.finish(auditId, "failed", "tests_failed");
        return {
          auditId,
          branch,
          commit: currentCommit,
          outcome: "failed",
          reason: "tests_failed",
          tests,
          diffStat,
          logTail: combinedLogTail,
          decision: {
            readyToMerge: false,
            score: readyScore,
            fallback: decision.fallback,
            cost: decision.cost,
            error: decision.error,
          },
        };
      }

      // 14. If Jev confidence is below threshold or fallback occurred
      if (readyScore < this.threshold || decision.fallback) {
        const reason = decision.fallback ? "jev_fallback" : "low_confidence";
        await this.deps.audit.finish(auditId, "review", reason);
        return {
          auditId,
          branch,
          commit: currentCommit,
          outcome: "review",
          reason,
          tests,
          diffStat,
          logTail: combinedLogTail,
          decision: {
            readyToMerge: false,
            score: readyScore,
            fallback: decision.fallback,
            cost: decision.cost,
            error: decision.error,
          },
        };
      }

      // 15. Safe v0: Jev decided ready to merge; code NEVER merges or deploys, ONLY marks ready_for_review
      await this.deps.state.markDone(key);
      this.deps.gate.record(this.group);
      await this.deps.audit.finish(auditId, "review", "ready_for_review");

      return {
        auditId,
        branch,
        commit: currentCommit,
        outcome: "review",
        reason: "ready_for_review",
        tests,
        diffStat,
        logTail: combinedLogTail,
        decision: {
          readyToMerge: true,
          score: readyScore,
          fallback: false,
          cost: decision.cost,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await step("error", { message: redact(msg) });
      await this.deps.audit.finish(auditId, "failed", "internal_error");
      throw err;
    }
  }
}
