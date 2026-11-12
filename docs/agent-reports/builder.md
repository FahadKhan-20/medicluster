# Builder (Self-Coding, Safe v0) Report

## Overview
Implemented the autonomous Builder workflow (`src/builder/*`) for `agent-core` with strict safety guarantees:
- **Git Worktree Isolation**: Spawns tasks in an isolated git worktree branch `builder/<slug>-<random>` branched from HEAD.
- **Configurable CLI Execution**: Runs a configurable coding agent CLI non-interactively (default: `agy -p --dangerously-skip-permissions`, configurable via `BUILDER_CMD` environment variable or constructor dependency) with the task title and description.
- **Verification via Repo Tests**: Executes both test suites inside the isolated worktree:
  - `agent-core` vitest (`npx vitest run`)
  - `medicluster/backend` node test runner (`npm test`)
- **Safe Decision Layer via Jev**:
  - Uses Jev `noul` question (`BUILDER_JEV_QUESTIONS.ready_to_merge`) evaluated over test results + diff stat.
  - **Zero Unsanctioned Writes**: Never merges or deploys changes; only marks `ready_for_review`.
- **Enforced Safety & Audit Trail**:
  - Kill-switch rechecks (`state.isStopped()`) before worktree creation, before agent CLI execution, and before final decision write.
  - Idempotency checks (`state.isDone(key)`) preventing duplicate execution.
  - Gate policy integration (`builder: suggest` in `policy.yaml`) with rate limiting and fallback protections.
  - Comprehensive append-only audit log recording every stage: worktree creation, agent CLI output, test execution, diff stat, HEAD commit, and Jev decision.
- **HTTP Endpoint**:
  - `POST /builder/task` with `{ title, description }`, authenticated via `x-admin-key`.

## Pre-Merge Safety Review (Fix Round)
Completed all 7 blocker items:
1. **Pre-CLI Gate Check & Required Gate**:
   - `Gate` is now a required dependency of `BuilderService`.
   - Before spawning the agent CLI, `gate.check({ group: "builder", action: "spawn_agent", ... })` is called, requiring a non-blocked verdict.
   - Added `builder: suggest` to `agent-core/policy.yaml`.
2. **Environment Scrubbing**:
   - Spawns the CLI child process with a strictly scrubbed environment: only `PATH`, `HOME`, `LANG`, `TERM`, plus an explicit allowlist from `BUILDER_ENV_ALLOW` (comma-separated).
   - Explicitly forbids all sensitive keys/patterns: `*ADMIN*`, `SUPABASE_*`, `AGENT_JWT_SECRET`, `*SECRET*`, `OPENROUTER*`, `OMNIROUTE*`, `*KEY*`.
3. **Git Push/Merge Blocking & Ref Tampering Verification**:
   - In the worktree before running the CLI, enabled `extensions.worktreeConfig`, set `remote.*.pushurl=no_push`, `remote.pushdefault=no_push`, and set `core.hooksPath` to an isolated empty directory (`.empty_hooks`).
   - Before running the CLI, snapshotted main repository HEAD commit and all branch refs (`refs/heads/*`). After the CLI finishes, verified that main repo HEAD and all existing branch refs other than `builder/<slug>` remain unmodified. Any tampering triggers an audit `security_alert` and immediately fails the task (`main_repo_refs_modified`).
4. **Isolated Dependency Installation**:
   - Removed symlinking of main `node_modules`.
   - Runs `npm ci --prefer-offline` in `worktree/agent-core` and `worktree/medicluster/backend`.
5. **Concurrency Cap & Random Suffix**:
   - Enforced global concurrency cap of 1 and per-slug mutual exclusion lock. If a task is active, subsequent tasks are rejected with HTTP 409 (`BuilderConcurrencyError`).
   - Appends a 6-character random hex suffix to the slug (`builder/<slug>-<random>`) so repeated titles never collide or reuse a worktree.
6. **Kill Switch Active Polling**:
   - Polls `state.isStopped()` every 5 seconds (configurable) while the child process runs.
   - When stopped, sends `SIGTERM` to the child process followed by `SIGKILL` if necessary, terminating the run and marking outcome `blocked`, reason `stopped`.
7. **Secret Redaction in Logs**:
   - Automatically detects all environment values longer than 12 characters from the parent environment.
   - Redacts all occurrences with `[REDACTED]` from all output tails (`agentTail`, `vitestTail`, `backendTail`, `combinedLogTail`), diff statistics, and HTTP responses before recording in the audit log.

## Files Added and Modified

### New Files
- `agent-core/src/builder/types.ts`: TypeScript interfaces for tasks, test summaries, process options, and builder outputs.
- `agent-core/src/builder/runner.ts`: `ProcessRunner` interface, `NodeProcessRunner` (with kill switch polling and timeout handling), `FakeProcessRunner`, `scrubEnv`, `redactSecrets`, `collectSecrets`, and `tail` output truncation helper.
- `agent-core/src/builder/git.ts`: `GitClient` helper wrapping git commands (`createWorktree`, `configureWorktreeSecurity`, `getHeadCommit`, `getBranchRefs`, `verifyMainRepoRefs`, `getDiffStat`, `ensureCommitted`, `removeWorktree`).
- `agent-core/src/builder/builder.ts`: `BuilderService` coordinating concurrency locks, pre-CLI gate check, worktree management, dependency installation, scrubbed CLI execution, ref verification, test runs, diff statistics, Jev decisions, Gate enforcement, secret redaction, and audit logging.
- `agent-core/tests/builder.test.ts`: 15 comprehensive unit and integration test cases covering the entire lifecycle and all 7 safety review blockers.

### Modified Files
- `agent-core/policy.yaml`: Added `builder: suggest`.
- `agent-core/src/api/server.ts`: Added `POST /builder/task` route with admin key authorization, 409 concurrency error handling, body validation, and `BuilderService` dispatch.
- `agent-core/src/main.ts`: Registered `BuilderService` and wired it into `createServer`.

## Test Output Summary

### Agent Core Vitest
- **Command**: `npx vitest run` in `agent-core/`
- **Results**: 11 test files passed, 158 tests passed (including 15 builder tests).
- **TypeScript**: `npx tsc --noEmit -p .` passed cleanly with 0 type errors.

### Backend Tests
- **Command**: `npm test` (`node --test --test-concurrency=1 tests/*.test.js`) in `medicluster/backend/`
- **Results**: 106 tests passed, 0 failures.

## Left Undone / Out of Scope
- Nightly self-test trigger was explicitly noted as out of scope in the task specification and was not implemented.
