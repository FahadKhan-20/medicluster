# Builder (Self-Coding, Safe v0) Report

## Overview
Implemented the autonomous Builder workflow (`src/builder/*`) for `agent-core` with strict safety guarantees:
- **Git Worktree Isolation**: Spawns tasks in an isolated git worktree branch `builder/<slug>` branched from HEAD.
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
  - Gate policy integration (`builder: auto/suggest`) with rate limiting and fallback protections.
  - Comprehensive append-only audit log recording every stage: worktree creation, agent CLI output, test execution, diff stat, HEAD commit, and Jev decision.
- **HTTP Endpoint**:
  - `POST /builder/task` with `{ title, description }`, authenticated via `x-admin-key`.

## Files Added and Modified

### New Files
- `agent-core/src/builder/types.ts`: TypeScript interfaces for tasks, test summaries, process results, and builder outputs.
- `agent-core/src/builder/runner.ts`: `ProcessRunner` interface, `NodeProcessRunner` (child_process with timeouts and bounded buffers), `FakeProcessRunner` for tests, and `tail` output truncation helper.
- `agent-core/src/builder/git.ts`: `GitClient` helper wrapping git commands (`createWorktree`, `getHeadCommit`, `getDiffStat`, `ensureCommitted`, `removeWorktree`).
- `agent-core/src/builder/builder.ts`: `BuilderService` coordinating slugification, kill switch checks, worktree management, CLI execution, test runs, diff statistics, Jev decisions, Gate enforcement, and audit logging.
- `agent-core/tests/builder.test.ts`: 14 unit and integration test cases covering happy path, kill-switch blocks, duplicate prevention, test failures, Jev low confidence / fallback, custom CLI commands, and HTTP API validation & execution.

### Modified Files
- `agent-core/src/api/server.ts`: Added `POST /builder/task` route with admin key authorization, body validation, and `BuilderService` dispatch.
- `agent-core/src/main.ts`: Registered `BuilderService` and wired it into `createServer`.

## Test Output Summary

### Agent Core Vitest
- **Command**: `npx vitest run` in `agent-core/`
- **Results**: 11 test files passed, 157 tests passed (including 14 new builder tests).
- **TypeScript**: `npx tsc --noEmit -p .` passed cleanly with 0 type errors.

### Backend Tests
- **Command**: `npm test` (`node --test --test-concurrency=1 tests/*.test.js`) in `medicluster/backend/`
- **Results**: 106 tests passed, 0 failures.

## Decisions and Notes
1. **Never Merge or Deploy**: In accordance with the prompt's safety rules, builder never merges or pushes git branches. All successful tasks end with outcome `review` and reason `ready_for_review`, leaving the `builder/<slug>` branch intact for human reviewer inspection.
2. **Untracked Node Modules in Worktrees**: In real git worktrees, untracked `node_modules` are not present by default. `BuilderService` incorporates best-effort symlinking of `agent-core/node_modules` and `medicluster/backend/node_modules` from the main repository into the worktree to ensure test runners can run without requiring slow `npm ci` installs.
3. **ProcessRunner Abstraction**: Spawning and process execution are decoupled through `ProcessRunner`, allowing comprehensive, deterministic unit testing via `FakeProcessRunner` without requiring real git branches or CLI executions during tests.

## Left Undone / Out of Scope
- Nightly self-test trigger was explicitly noted as out of scope in the task specification and was not implemented.
