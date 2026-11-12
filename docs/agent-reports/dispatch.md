# Parallel SDD Task Report: Dispatch (SOS -> Ambulance)

## Overview
Implemented automated emergency ambulance dispatch workflow for MediCluster:
- Connected `agent-core` to the `ambulance-dispatch` API (port 3001, `DISPATCH_URL`).
- Evaluates incoming emergency incidents (including patient SOS emergencies created via `patientCad.js`).
- Enforces hard safety invariants: only PENDING incidents are dispatched; incidents already assigned are never reassigned.
- Utilizes Gemini for fact-only state generation (extracting distances, ETAs, unit types without medical interpretation).
- Employs Jev for multi-choice candidate unit selection (`choice`) and action safety determination (`noul act_now`).
- Enforces strict safety via `Gate` (defaulting to `"dispatch: suggest"` where human dispatcher confirms; configurable to `"auto"` when Jev confidence and act_now are >= 0.9 threshold).
- Pre-write and in-flight kill switch rechecks and idempotency key locks (`dispatch:<incident_id>`).
- Calls the atomic assignment endpoint (`POST /api/assignments`) to assign ambulance and hospital resources simultaneously.
- Added minimal agent JWT authentication to `ambulance-dispatch/backend/api/server.js` using HMAC-SHA256 constant-time verification.

## Pre-Merge Safety Review Fixes
1. **Agent Token Route Allowlist & Exp Validation (`server.js`)**:
   - Restricted agent tokens to an exact allowlist: `GET /api/incidents*`, `GET /api/ambulances*`, `GET /api/hospitals*`, `GET /api/assignments/recommendations*`, and `POST /api/assignments`.
   - Every other `/api` route (e.g. `GET /api/auth/me`, `POST /api/incidents`, `PATCH /api/incidents/:id/status`, `POST /api/auth/logout`) returns 403 `Agent access not permitted for this route` when called with an agent token.
   - Enforced that `payload.exp` must be a finite number (`typeof payload.exp === 'number' && Number.isFinite(payload.exp)`), rejecting tokens without `exp` or with non-numeric values.
   - Verified via unit tests in `ambulance-dispatch/backend/api/tests/agentAuth.test.js`.

2. **Incident Pre-Write Refetch & Pre-Run Kill Switch Recheck (`workflows/dispatch.ts`)**:
   - Right before executing the assignment inside the key lock, `DispatchWorkflow` always refetches the incident from `getIncident`.
   - Verifies `status === 'PENDING'` and `!assigned_ambulance_id` (blocking if the incident was resolved, cancelled, or assigned concurrently).
   - Rechecks the kill switch (`state.isStopped()`) immediately before `DISPATCH_ASSIGN_TOOL.run`, after hospital lookups complete.
   - Verified via unit tests in `agent-core/tests/dispatch.test.ts`.

3. **Non-Idempotent POST Protection (`tools/dispatch.ts`)**:
   - Configured `DispatchClient.call` to never retry POST requests (1 single attempt on failure with `retryable: false`). Only idempotent GET requests retry on 5xx.
   - Verified via unit tests in `agent-core/tests/dispatchTools.test.ts`.

4. **Service Wiring & Polling (`main.ts`)**:
   - Added `dispatch: `${dispatchUrl}/health`` target to `HealthPoller` so `health.isUp("dispatch")` functions.
   - Included `dispatchWorkflow.retryPending()` in the main `retryPending` aggregation.
   - Implemented a 10-second polling loop (`dispatchClient.getPendingIncidents()`) feeding pending, unassigned incidents into `dispatchWorkflow.handle(...)`.
   - Properly wired timer cleanup and in-flight drainage to graceful shutdown handlers.
   - Verified via unit tests in `agent-core/tests/mainWiring.test.ts`.

## Files Created and Modified

### New Files
- `agent-core/src/tools/dispatch.ts`:
  - `DispatchClient` with non-retry POST, retry GET, bearer token handling, and typed methods (`getIncident`, `getPendingIncidents`, `getAvailableAmbulances`, `getRecommendations`, `getScoredHospitals`, `assignAmbulance`).
  - `DISPATCH_ASSIGN_TOOL` self-validating dispatch assignment tool.
- `agent-core/src/workflows/dispatch.ts`:
  - `DispatchWorkflow` implementing the full decision loop: PENDING check, unit fetching, fact building via Gemini, Jev decider, Gate checks, kill switch checks, key locking, pre-write incident refetch, hospital resolution, pre-tool kill switch recheck, atomic assignment execution, audit logging, and queue retry.
  - `createDispatchWorkflow` registration helper.
- `agent-core/tests/dispatchTools.test.ts`:
  - Unit tests for `DispatchClient` (defaults, bearer token, non-retry POST, 5xx GET retries, 4xx non-retry, endpoint calls) and `DISPATCH_ASSIGN_TOOL` validation.
- `agent-core/tests/dispatch.test.ts`:
  - End-to-end unit tests with fakes for the dispatch workflow: auto execution, suggest level review, threshold checks (< 0.9), non-PENDING rejection, never-reassign guard, no units available, kill switch, pre-write status/assignment changes, pre-run kill switch trip, idempotency/duplicates, Jev fallback, LLM errors, 409 conflicts, 500 server errors, rate limiting, and queued event draining.
- `agent-core/tests/mainWiring.test.ts`:
  - Tests for dispatch health polling (`isUp("dispatch")`), dispatchWorkflow in retryPending, and dispatch polling loop.
- `ambulance-dispatch/backend/api/tests/agentAuth.test.js`:
  - Tests for minimal agent JWT authentication on the dispatch API (allowlist, 403 on non-allowlisted routes, number `exp` validation, tampered signature, expired token, non-agent token, sub/kind validation).

### Modified Files
- `agent-core/policy.yaml`:
  - Added `dispatch: suggest` to policy groups.
- `agent-core/src/main.ts`:
  - Added `DispatchClient`, wired `dispatchWorkflow` polling, health target `"dispatch"`, and aggregated retry.
- `ambulance-dispatch/backend/api/server.js`:
  - Added minimal agent JWT verification supporting `AGENT_JWT_SECRET`, route allowlist, and `exp` number validation.

## Test Output Summary
- `agent-core` Vitest:
  - 13 test files passed, 177 tests passed, 0 failures.
  - Includes 18 tests in `tests/dispatch.test.ts`, 13 tests in `tests/dispatchTools.test.ts`, and 3 tests in `tests/mainWiring.test.ts`.
- `agent-core` TypeScript:
  - `npx tsc --noEmit -p .` passed with 0 errors.
- `ambulance-dispatch/backend/api` Node Test:
  - `node --test tests/*.test.js` passed: 21 tests passed, 0 failures (including 6 tests in `tests/agentAuth.test.js`).

## Left Undone / Notes
- Everything requested across both prompt rounds has been fully completed and verified with tests. Real DB migrations and docker compose were avoided per the task rules.
