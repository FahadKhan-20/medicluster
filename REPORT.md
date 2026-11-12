# Self-Heal Task Report

## Overview
Implemented an autonomous Docker self-healing subsystem for `agent-core` that monitors service health, uses Jev to decide recovery actions (`restart | wait | escalate`), enforces safety via policy gates and kill switches, and adheres strictly to a hard limit of at most 3 restarts per service per 10-minute window.

## Files Created and Modified
- **`agent-core/src/selfheal/docker.ts`** (NEW):
  - `DockerClient` interface (`inspect`, `restart`).
  - `DockerHttpController`: Pure Node.js `node:http` client communicating with Docker Engine API over `/var/run/docker.sock` without any new npm dependencies. Injectable `requestFn` and `socketPath` for testing.
  - `FakeDockerClient`: Test double tracking inspect and restart calls.
- **`agent-core/src/selfheal/tracker.ts`** (NEW):
  - `RestartTracker`: Sliding window tracker enforcing the hard rule of max 3 restarts per service per 10 minutes (600,000 ms), with injectable clock.
- **`agent-core/src/selfheal/loop.ts`** (NEW):
  - `SelfhealLoop`: Control loop handling `service.down` events from `HealthPoller` as well as direct container exit/unhealthy status events.
  - State compilation: Inspects container status, recent restarts, and passes fact-only state to Jev.
  - Jev decider: Decides `action` (`restart`, `wait`, `escalate`), `urgency`, and `act_now`.
  - Hard rule enforcement: When 3 restarts occurred within the last 10 minutes, automatically overrides `restart` to `escalate`.
  - Safety gate & kill switch: Checks policy group `selfheal` (or `alerts` for escalation), verify threshold, rate limits, and kill switch (`state.isStopped()`).
  - Write path & audit: Uses in-flight locks and idempotency keys (`${event.id}:${action}`), logs all steps via `Audit`, records rate limit in `Gate`, and marks keys done in `AgentState`.
  - Escalation: Calls `alerts.create` tool (`/api/alerts/agent`) with complete payload. If backend is down, returns `pending` and enqueues event for retry.
  - Container mapping: Resolves service names to container names from `SELFHEAL_CONTAINERS` env JSON, defaulting to `{"backend":"medicluster-backend-1","ml":"medicluster-ml-engine-1"}`.
- **`agent-core/src/selfheal/index.ts`** (NEW):
  - Module exports and `registerSelfheal` function to wire `HealthPoller` events to `SelfhealLoop`.
- **`agent-core/policy.yaml`** (MODIFIED):
  - Added policy group `selfheal: auto`.
- **`agent-core/src/main.ts`** (MODIFIED):
  - Added registration line for `registerSelfheal(health, { ... })`.
- **`medicluster/docker-compose.yml`** (MODIFIED):
  - Mounted `/var/run/docker.sock:/var/run/docker.sock` in the `agent-core` service.
- **`agent-core/tests/selfheal.test.ts`** (NEW):
  - 21 unit and integration tests covering `DockerHttpController`, `RestartTracker`, container mapping, Gate checks, kill switch, hard limit escalation, idempotency, and `registerSelfheal`.

## Decisions & Design Notes
1. **Zero New Dependencies**: Used Node's built-in `http.request` with `socketPath` for Docker Engine API interactions.
2. **Defense-in-Depth Hard Rule**: The 3 restarts / 10 min rule is passed to Jev in the state facts, checked before Gate evaluation, and rechecked immediately before calling `docker.restart` within the locked write path.
3. **Escalation via `alerts.create`**: Uses existing `alerts.create` tool and adheres to required schemas (`patient_id: "system"`, `source_id: service`, `severity: "CRITICAL"`).
4. **Resilience under Service Outages**: If backend itself is failing and escalation alert delivery fails, the event is marked `pending` and enqueued in `AgentState` so `retryPending()` can deliver it once backend recovers.

## Test Output Summary
- `npx vitest run`:
  - Test files: 11 passed (100%)
  - Tests: 164 passed (21 new tests in `tests/selfheal.test.ts`, 143 existing tests in 10 test files)
  - Time: ~0.73s
- `npx tsc --noEmit -p .`:
  - 0 errors, clean TypeScript build.

## Anything Left Undone
None. All requirements specified in `selfheal.md` are implemented, fully tested, and committed.
