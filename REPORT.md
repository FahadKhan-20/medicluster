# Decision Replay Implementation Report

**Worktree**: `/home/vinay/mc2-replay`  
**Branch**: `par2/replay`  
**Task Specification**: `/home/vinay/medicluster-agent-core/.superpowers/sdd/parallel/t-replay.md`

---

## 1. Executive Summary

Decision Replay has been implemented for the Agent Auditor console (`/console`). It allows clinical operators and auditors to step through agent decisions across 6 distinct evaluation stages:
1. **Event**: Ingestion metadata (event type, media ID, patient ID, event timestamp, raw event payload).
2. **Gemini State**: Facts extracted by Gemini from clinical documents/scans.
3. **Jev Decision & Probabilities**: Question evaluation with probability distribution bars, highlighted chosen option, Act-Now noul score, and red-flagged fallback banner with failure reasons.
4. **Gate Result**: Clinical safety gate evaluation including safety level, confidence threshold, verdict, and reason.
5. **Tool Calls**: Tool executions with names, arguments (truncated to 500 characters), execution status, duration, and error banners.
6. **Outcome**: Final decision score visualization, termination reason, and end-to-end latency.

---

## 2. Changes Made

### 2.1 Backend API (`agent-core/src/api/server.ts`)
- Added audit ID regex validation: `/^[A-Za-z0-9_-]{1,128}$/`.
- Implemented `GET /audit/:id` endpoint:
  - Requires `x-admin-key` header; returns `401 Unauthorized` on missing or invalid key.
  - Validates audit ID format; returns `400 Invalid audit id` on malformed, oversized (>128 chars), or empty IDs.
  - Retrieves audit records using `deps.audit.get(id)` or `deps.store.find("agent_audit", { _id: id })`.
  - Returns `404 Audit not found` when no record matches.
  - Returns `200 OK` with the full audit JSON document on match.

### 2.2 Rendering and Sanitization Engine (`agent-core/src/console/render.ts`)
- Implemented `escapeHtml(value)`: Strictly encodes `<`, `>`, `&`, `"`, `'` to prevent XSS attacks from audit payloads.
- Implemented `truncateString(value, maxLength = 500)` and `truncateDeep(obj, maxLength = 500)`: Ensures arguments and string values exceeding 500 characters are safely capped with a truncation notice.
- Implemented `formatJsonSafe(value, maxLength = 500)`: Deep-truncates JSON payloads and safely escapes them for `<pre>` code block rendering.
- Implemented `renderReplayStep(stepIndex, audit)`: Modular step renderer generating HTML for steps 1 through 6, fully sanitized and formatted according to design tokens.
- Exported from `agent-core/src/console/index.ts` for reusability and testing.

### 2.3 Auditor Console UI (`agent-core/src/console/index.html`)
- Preserved the existing dark-mode design system, typography, and color tokens (`--bg-primary`, `--bg-card`, `--col-pass`, `--col-escalate`, `--col-block`).
- Added `#replayModal` overlay with:
  - Replay header showing event type, audit ID, and playback indicator.
  - 6-step interactive track with step pills (`1: Event`, `2: State`, `3: Jev`, `4: Gate`, `5: Tools`, `6: Outcome`).
  - Navigation controls: `Prev Step`, `Play` / `Pause` (with pulsing indicator), and `Next Step`.
  - Auto-play advancing steps automatically every 1.2 seconds (stopping automatically upon reaching Step 6).
  - Keyboard shortcuts: `ArrowLeft` (previous step), `ArrowRight` (next step), `Space` (toggle play/pause), `Escape` (close replay modal).
  - Wired audit table row clicks and drawer button directly to `openReplay(id, 1)`.

### 2.4 Test Suite (`agent-core/tests/replay.test.ts`)
Added 19 automated tests covering:
- **Authentication**: `GET /audit/:id` returns 401 without `x-admin-key` or with invalid keys.
- **Validation**: Rejects invalid characters (e.g. `bad$id`, `@special`, `<script>`, spaces) and oversized IDs (>128 chars) with 400.
- **Lookup**: Returns 404 for missing IDs, and 200 with full audit document for valid IDs via store and `audit.get`.
- **Sanitization**: Verifies `escapeHtml` against XSS injections (`<script>`, `<img onerror>`, etc.).
- **Truncation**: Verifies `truncateString` and `truncateDeep` cap strings > 500 chars.
- **Multi-step Rendering**: Validates all 6 replay step views against adversarial XSS inputs and large payloads.

---

## 3. Verification & Test Results

1. **Vitest Test Suite**:
   ```
   npx vitest run
   Test Files  22 passed (22)
        Tests  350 passed (350)
   ```
2. **TypeScript Compilation**:
   ```
   npx tsc --noEmit -p .
   (Clean exit, 0 errors)
   ```
3. **Safety & Security**:
   - Zero raw HTML rendered from dynamic audit data.
   - Long arguments/results capped to 500 characters.
   - Strictly enforced authentication and audit ID validation.
   - No Docker containers modified, no real database accessed, no git push executed.
