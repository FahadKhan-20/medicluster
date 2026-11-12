import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import { noul, type Decider } from "../judge/jev.js";
import { GitClient } from "./git.js";
import { NodeProcessRunner, splitArgs, tail } from "./runner.js";
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

function trySymlinkNodeModules(sourceDir: string, targetDir: string): void {
  try {
    if (fs.existsSync(sourceDir) && !fs.existsSync(targetDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.symlinkSync(sourceDir, targetDir, "junction");
    }
  } catch {
    // Best-effort symlink; ignore errors if permissions or cross-device
  }
}

export interface BuilderDeps {
  audit: Pick<Audit, "start" | "append" | "finish">;
  state: Pick<AgentState, "isStopped" | "isDone" | "markDone">;
  jev: Decider;
  gate?: Pick<Gate, "check" | "record">;
  runner?: ProcessRunner;
  repoRoot?: string;
  worktreeBaseDir?: string;
  builderCmd?: string;
  vitestCmd?: string;
  backendTestCmd?: string;
  threshold?: number;
  group?: string;
}

export class BuilderService {
  private readonly runner: ProcessRunner;
  private readonly git: GitClient;
  private readonly repoRoot: string;
  private readonly worktreeBaseDir: string;
  private readonly builderCmd: string;
  private readonly vitestCmd: string;
  private readonly backendTestCmd: string;
  private readonly threshold: number;
  private readonly group: string;

  constructor(private readonly deps: BuilderDeps) {
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
  }

  async handleTask(task: BuilderTask): Promise<BuilderResult> {
    const slug = slugify(task.title);
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
        logTail: "kill switch is active (stopped)",
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
        logTail: "task already completed",
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

      // Best effort reuse of existing node_modules
      trySymlinkNodeModules(
        path.join(this.repoRoot, "agent-core", "node_modules"),
        path.join(worktreeDir, "agent-core", "node_modules")
      );
      trySymlinkNodeModules(
        path.join(this.repoRoot, "medicluster", "backend", "node_modules"),
        path.join(worktreeDir, "medicluster", "backend", "node_modules")
      );

      await step("worktree_created", { branch, worktreeDir, baseCommit });

      // 5. Re-check kill switch before executing CLI
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
          logTail: "kill switch activated before agent execution",
        };
      }

      // 6. Run coding agent CLI non-interactively inside the worktree
      const taskText = `Task: ${task.title}\n\n${task.description}`;
      const [cmdExe, ...cmdArgs] = splitArgs(this.builderCmd);
      const agentRes = await this.runner.run(
        cmdExe,
        [...cmdArgs, taskText],
        { cwd: worktreeDir }
      );

      const agentTail = tail(agentRes.stdout + "\n" + agentRes.stderr);
      await step("agent_run", {
        cmd: this.builderCmd,
        exitCode: agentRes.exitCode,
        durationMs: agentRes.durationMs,
        logTail: agentTail,
      });

      // 7. Ensure changes are committed and inspect HEAD commit and diff
      await this.git.ensureCommitted(worktreeDir, `builder: ${task.title}`);
      const currentCommit = await this.git.getHeadCommit(worktreeDir);
      const diffStat = await this.git.getDiffStat(worktreeDir, baseCommit);

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

      const vitestTail = tail(vitestRes.stdout + "\n" + vitestRes.stderr);
      const backendTail = tail(backendRes.stdout + "\n" + backendRes.stderr);
      const combinedLogTail = tail(
        `[agent-core vitest - exit ${vitestRes.exitCode}]\n${vitestTail}\n\n[backend node --test - exit ${backendRes.exitCode}]\n${backendTail}`
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

      // 12. Gate safety check if gate provided
      if (this.deps.gate) {
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
      if (this.deps.gate) this.deps.gate.record(this.group);
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
      await step("error", { message: msg });
      await this.deps.audit.finish(auditId, "failed", "internal_error");
      throw err;
    }
  }
}
