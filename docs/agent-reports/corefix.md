# Corefix Implementation Report

## Overview
This report details the implementation of fixes addressing the findings from `final-review.md` as outlined in `corefix.md`. All work was performed in `/home/vinay/mc-par-corefix` on branch `par/corefix`.

---

## Review Findings Addressed

### 1. Critical #1: Analysis Model Selection & Idempotency
- **Model Selection (`agent-core/src/agent/loop.ts`)**:
  - Implemented `chooseAnalysisModel(doc)` to inspect document modality, mimetype, and model metadata.
  - Standard chest X-rays / plain radiography select `densenet121-res224-all` (passed in `/api/media/analyze` request body).
  - Explicit brain / MRI / NIfTI scans (`application/x-nifti`, `brain-mri-*`, etc.) route directly to audit review rather than misrouting to the 2D chest model.
- **Alert Idempotency (`medicluster/backend/models/AgentAlert.js`, `medicluster/backend/routes/alertRoutes.js`, `agent-core/src/tools/registry.ts`)**:
  - Added `idem_key: { type: String, index: true, sparse: true }` to `AgentAlert` Mongoose schema.
  - Updated alert POST route in backend to check existing alerts by `idem_key` (with backward-compatible fallback to `source_id` + `audit_id`).
  - Added `idem_key` support to `ALERT_PROPS` in `registry.ts` and ensured tool execution filters payloads strictly to allowed schema properties.
  - Added unit test in `medicluster/backend/tests/agentAlerts.test.js` validating duplicate `idem_key` returns existing alert without duplicate record creation.

### 2. Important #2: Store Request Timeout Protection
- **`agent-core/src/store/mc.ts`**:
  - Added default 30-second abort signal (`AbortSignal.timeout(timeoutMs)`) across all Supabase client fetch calls to prevent hung requests during network partitions.

### 3. Important #3: Realtime Event Resilience & Catch-up Sweep
- **`agent-core/src/events/events.ts`**:
  - Implemented periodic catch-up sweep (`sweepIntervalMs = 60_000`) polling `medicluster_records` and `audit_trail` for recent unhandled events to ensure delivery even if realtime notifications drop.
  - Handled realtime connection status: `CLOSED` state transitions now mark the connection as degraded and trigger reconnection attempts.
  - Handled payload omission: When Supabase realtime payloads omit record details for large rows, the document is re-fetched by `p.new.id`.

### 4. Important #4: Tool Backend Timeouts & Safe Non-Idempotent Handling
- **`agent-core/src/tools/backend.ts`**:
  - Supported per-call timeout overrides via `options?: { timeoutMs?: number }`.
  - Configured `/api/media/analyze` to use a minimum 130-second timeout (`130_000ms`), accounting for cold starts and heavy model inference.
  - Guarded against re-invoking non-idempotent POST endpoints upon timeout (e.g. inference requests that may already be processing on the server).

### 5. Important #5: Race Condition & Upload Debouncing
- **`agent-core/src/agent/loop.ts`**:
  - Implemented debouncing for `scan.uploaded` events: queued with `notBefore = uploadedAt + 120s` to avoid racing with manual clinician review or concurrent batch uploads.
  - Implemented just-in-time state checks: re-reads the media document from store right before executing analysis tools; skips execution if `already_analyzed` is true.

### 6. Important #6: Terminal Outcome Decided Markers
- **`agent-core/src/control/state.ts` & `agent-core/src/agent/loop.ts`**:
  - Added `isDecided(eventId)` and `markDecided(eventId, outcome)` in agent state store using `decided:<eventId>` keys.
  - Terminal outcomes (`executed`, `review`, `skipped`, `failed`) persist decision markers.
  - Duplicate events check `isDecided(eventId)` and return `{ outcome: "skipped", keep: false }` immediately without redundant tool invocations or duplicate audit logs.

### 7. Important #7: Exponential Backoff & Queue Persistence
- **`agent-core/src/control/state.ts` & `agent-core/src/agent/loop.ts`**:
  - Extended queue schema to track `notBefore` and `attempts`.
  - Implemented `calculateBackoffMs(attempt)` providing exponential backoff: 60s, 120s, 240s, up to 1800s max backoff.
  - Queued retries are capped at 10 attempts before transitioning to terminal failure (`markFailed`).
  - Added `dueOnly` option to `state.drain({ dueOnly: true, now })` so retry loops only process events whose `notBefore` threshold has passed.

### 8. Important #8: Patient Record Association Validation
- **`agent-core/src/agent/loop.ts`**:
  - Implemented `isRecordPatient(patient)` to validate that media belongs to a registered clinical patient.
  - Unlinked sessions or anonymous test uploads (e.g. `"imaging-session"`) are skipped from clinician alert creation and backend review dispatch.

### 9. Minors & Docker Compose Fixes
- **`medicluster/docker-compose.yml`**:
  - Corrected backend environment variable to `${AGENT_JWT_SECRET:-}`.
  - Updated `agent-core` `OMNIROUTE_URL` to default to `http://host.docker.internal:20128`.
  - Added `extra_hosts: ["host.docker.internal:host-gateway"]` to `agent-core` service.
  - Mounted `policy.yaml` read-only volume (`../agent-core/policy.yaml:/app/policy.yaml:ro`).
- **Audit Logging Sanitization**:
  - Stripped heavy binary payloads (`heatmap_data_url`, base64 masks, localized contours) from audit logs before persisting to store.
  - Avoided creating empty audit entries for unsupported or non-image files.

---

## Test Verification

### Agent Core Test Suite
- Command: `cd agent-core && npx vitest run && npx tsc --noEmit -p .`
- Results:
  - Vitest: **10 test files passed, 155 tests passed** (0 failures).
  - TypeScript: Zero compiler diagnostics (`tsc --noEmit -p .` succeeded with exit code 0).

### Backend Test Suite
- Command: `cd medicluster/backend && npm test`
- Results:
  - Node Test Runner: **107 tests passed** (0 failures).
