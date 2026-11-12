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

## Files Created and Modified

### New Files
- `agent-core/src/tools/dispatch.ts`:
  - `DispatchClient` with retries, exponential backoff, bearer token handling, and typed methods (`getIncident`, `getAvailableAmbulances`, `getRecommendations`, `getScoredHospitals`, `assignAmbulance`).
  - `DISPATCH_ASSIGN_TOOL` self-validating dispatch assignment tool.
- `agent-core/src/workflows/dispatch.ts`:
  - `DispatchWorkflow` implementing the full decision loop: PENDING check, unit fetching, fact building via Gemini, Jev decider, Gate checks, kill switch checks, key locking, hospital resolution, atomic assignment execution, audit logging, and queue retry.
  - `createDispatchWorkflow` registration helper.
- `agent-core/tests/dispatchTools.test.ts`:
  - Unit tests for `DispatchClient` (defaults, bearer token, 5xx retries, 4xx non-retry, endpoint calls) and `DISPATCH_ASSIGN_TOOL` validation.
- `agent-core/tests/dispatch.test.ts`:
  - End-to-end unit tests with fakes for the dispatch workflow: auto execution, suggest level review, threshold checks (< 0.9), non-PENDING rejection, never-reassign guard, no units available, kill switch, idempotency/duplicates, Jev fallback, LLM errors, 409 conflicts, 500 server errors, rate limiting, and queued event draining.
- `ambulance-dispatch/backend/api/tests/agentAuth.test.js`:
  - Tests for minimal agent JWT authentication on the dispatch API (valid token, tampered signature, expired token, non-agent token, sub/kind validation).

### Modified Files
- `agent-core/policy.yaml`:
  - Added `dispatch: suggest` to policy groups.
- `agent-core/src/main.ts`:
  - Added registration line for `createDispatchWorkflow`.
- `ambulance-dispatch/backend/api/server.js`:
  - Added minimal agent JWT verification supporting `AGENT_JWT_SECRET` for dispatcher role access.

## Test Output Summary
- `agent-core` Vitest:
  - 12 test files passed, 168 tests passed, 0 failures.
  - Includes 15 new tests in `tests/dispatch.test.ts` and 10 new tests in `tests/dispatchTools.test.ts`.
- `agent-core` TypeScript:
  - `npx tsc --noEmit -p .` passed with 0 errors.
- `ambulance-dispatch/backend/api` Node Test:
  - `node --test tests/*.test.js` passed: 20 tests passed, 0 failures (including 6 new tests in `tests/agentAuth.test.js`).

## Left Undone / Notes
- Everything requested has been fully completed and verified with tests. Real DB migrations and docker compose were avoided per the task rules.
