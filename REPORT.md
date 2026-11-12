# Self-Heal Task Report

## Overview
Implemented an autonomous Docker self-healing subsystem for `agent-core` that monitors service health, uses Jev to decide recovery actions (`restart | wait | escalate`), enforces safety via policy gates and kill switches, and adheres strictly to a hard limit of at most 3 restarts per service per 10-minute window.

## Fix Round (Pre-Merge Safety & Architecture Review)
Addressed all feedback items from `fix-selfheal.md`:
1. **Isolated Docker Socket Proxy**:
   - Removed `/var/run/docker.sock` mount from the base `medicluster/docker-compose.yml`.
   - Created opt-in compose override `medicluster/docker-compose.selfheal.yml` running `tecnativa/docker-socket-proxy:0.1.1` with a read-only socket mount (`/var/run/docker.sock:ro`) and strictly restricted permissions (`CONTAINERS=1` and `POST=1` only).
   - Added TCP support in `DockerHttpController` connecting via `DOCKER_HOST=tcp://docker-proxy:2375`.
   - Documented the opt-in compose override in `agent-core/README.md`.
2. **Container Name Validation & Anti-Self-Targeting**:
   - Container names are strictly validated against `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`.
   - Any container name containing `"agent-core"` is refused.
   - Used `Object.hasOwn(this.containers, service)` for safe prototype-pollution-free container lookups.
3. **Restart Attempt Accounting & Per-Service Concurrency Lock**:
   - Restart attempts are counted toward the 3 restarts / 10-minute limit before invoking Docker, ensuring even failed restart attempts count against the threshold.
   - Added a per-service lock (`activeRestarts`) so concurrent downtime events for the same service cannot simultaneously trigger restarts.
4. **Queue Ownership & Retry Coordination**:
   - `AgentLoop.process` returns `keep: true` for `service.down` events so `AgentLoop.drainQueue()` does not acknowledge or drop self-heal events.
   - Wired `selfheal.retryPending()` into `main.ts`'s 60-second retry interval and on `service.up` notifications.
   - Added test proving queued `service.down` events remain in the queue during `AgentLoop` passes and are properly retried and acknowledged by `SelfhealLoop`.
5. **Clean Health Listener & PII/Audit Hygiene**:
   - Added `addListener` to `HealthPoller` so `registerSelfheal` listens for health events without monkeypatching `health.start`.
   - Added `.catch` handler to `handleDown(e)` promise in `registerSelfheal`.
   - Completely dropped `ContainerInspect.raw` to prevent storing raw Docker JSON in events or audit logs.

## Files Created and Modified
- **`agent-core/src/selfheal/docker.ts`**:
  - `DockerClient` interface (`inspect`, `restart`).
  - `DockerHttpController`: Supports both Unix domain sockets and TCP hosts (`DOCKER_HOST`). Enforces container name validation (`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` and refuses `"agent-core"`).
  - Dropped `raw` inspection payload.
  - `FakeDockerClient`: Test double with inspect, restart, and failure simulation.
- **`agent-core/src/selfheal/tracker.ts`**:
  - `RestartTracker`: Sliding window tracker enforcing max 3 restart attempts per service per 10 minutes (600,000 ms), with injectable clock.
- **`agent-core/src/selfheal/loop.ts`**:
  - `SelfhealLoop`: Control loop handling `service.down` events from `HealthPoller` as well as direct container exit/unhealthy status events.
  - Uses `Object.hasOwn` for service lookups and validates container names.
  - Manages `activeRestarts` per-service in-process locks to prevent concurrent restarts.
  - Counts restart attempts toward the 3/10m limit.
  - Hard rule enforcement: Automatically redirects to `escalate` via `alerts.create` when limits are exceeded.
- **`agent-core/src/selfheal/index.ts`**:
  - Module exports and `registerSelfheal` function using `health.addListener` and explicit promise `.catch` handlers.
- **`agent-core/src/events/health.ts`**:
  - Added `addListener(listener)` to `HealthPoller`.
- **`agent-core/src/agent/loop.ts`**:
  - Changed `service.down` / `service.up` processing to return `keep: true` so `AgentLoop.drainQueue` does not prematurely acknowledge selfheal queue items.
- **`agent-core/src/main.ts`**:
  - Wires both `loop.retryPending()` and `selfheal.retryPending()` into `retry()`.
- **`agent-core/README.md`**:
  - Documented opt-in self-heal mode with `docker-compose.selfheal.yml`.
- **`medicluster/docker-compose.yml`**:
  - Base compose file without raw socket mount.
- **`medicluster/docker-compose.selfheal.yml`**:
  - Opt-in compose override with `docker-proxy` (`tecnativa/docker-socket-proxy:0.1.1`) and `DOCKER_HOST=tcp://docker-proxy:2375`.
- **`agent-core/tests/selfheal.test.ts`**:
  - 32 unit and integration tests covering socket & TCP controller, container validation, restart attempt tracking, per-service locks, queue preservation, and health listeners.

## Test Output Summary
- `npx vitest run`:
  - Test files: 11 passed (100%)
  - Tests: 175 passed (32 tests in `tests/selfheal.test.ts`, 143 existing tests in 10 test files)
  - Time: ~0.71s
- `npx tsc --noEmit -p .`:
  - 0 errors, clean TypeScript build.

## Anything Left Undone
None. All 5 items from `fix-selfheal.md` are completely resolved, tested, and verified.
