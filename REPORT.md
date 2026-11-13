# Task Report: Console 2 (CliniQ Product Rename & Real Workflow Status)

## Summary of Completed Work

### 1. Product Rename: "Agent Auditor" -> "CliniQ"
- Renamed all user-facing instances of the console product name to **CliniQ**:
  - HTML `<title>`: `CliniQ — MediCluster Agent`
  - Sidebar brand title: `CliniQ`
  - Main heading in home view: `CliniQ`
  - Subtitle retained: `Autonomous Clinical Decision & Safety Verification Feed`
  - MediCluster frontend Agent page button: `Open CliniQ Console`
  - Documentation and report references updated

### 2. Live Agent Workflows Status (`GET /agents`)
- Added authenticated endpoint `GET /agents` (requires `X-Admin-Key`) in `agent-core/src/api/server.ts`:
  - Returns array of registered workflows: `id`, `name`, `description`, `group`, `policyLevel`, `registered`, `deps` / `dependentServices` (with `health.isUp`), `lastEventAt`, `lastOutcome`, `counts` / `counts24h`, `status`, `reason`.
  - Registered workflows in `src/workflows/registry.ts`:
    - Imaging Scan Loop (`scan.*`)
    - Clinical Alerts (`alert.*`, `alerts.*`)
    - Medication Reminders (`reminder.*`)
    - Deterioration Radar (`radar.*`, `vitals.*`)
    - Sepsis Watch (`sepsis.*`)
    - ECG Interpretation (`ecg.*`)
    - Code Blue War Room (`codeblue.*`)
    - Ambulance Dispatch (`incident.*`)
    - Self-Heal Engine (`service.*`, `container.*`)
    - Spec Builder (`builder.*`)
    - Pharmacy Ops (`pharmacy.*`)
  - Status derivation:
    - `"active"`: registered + dependencies up + not stopped
    - `"degraded"`: a dependent service is down
    - `"paused"`: kill switch activated (`state.isStopped()`)
    - `"off"`: policy disabled in `policy.yaml`
    - `"not configured"`: missing prerequisites/env (e.g. `DISPATCH_URL`, `DOCKER_HOST`, `agy` CLI) or registered is false
  - 24-hour outcome metric computation from audit history (`executed`, `review`, `blocked`, `failed`, `pending`, `skipped`).
  - Most recent event detection (`lastEventAt`, `lastOutcome`).

### 3. Dynamic Console UI Rendering
- `agent-core/src/console/index.html`:
  - Dynamically renders workflows list in `Agent Workflows` view with status badges (active, degraded, paused, off, not configured), policy level, dependencies, 24h event volume, and configuration instructions for unconfigured agents.
  - Dynamically populates the sidebar agent tree list with total count badge.
  - Interactive workflow filtering: Clicking any workflow filters the live audit stream and sidebar to that workflow's events, with banner indication and "Show All" toggle.
  - Automatically polls `GET /agents` every 10 seconds.
- `agent-core/src/console/render.ts`:
  - Helpers `renderWorkflowRow` and `renderWorkflowList` ensuring safe HTML escaping and sanitization for all rendered workflow details.

### 4. Vitest Unit Tests & Type Safety
- Added `agent-core/tests/workflows.test.ts`:
  - Authentication tests for `GET /agents` (401 without key / wrong key, 200 with valid key).
  - Status derivation tests (active, degraded, paused, off, not configured).
  - 24-hour audit metrics computation and last event extraction.
  - HTML escaping / XSS protection tests for workflow rendering.
- All 24 test suites in `agent-core` pass (377 tests passed).
- TypeScript check (`npx tsc --noEmit`) passes with zero errors.
