# MediCluster Demo Runner Report

## Overview
Implemented an autonomous, one-click CLI demo runner (`agent-core/scripts/demo.ts`) executable via `npm run demo` in `agent-core`. The runner exercises all five autonomous clinical agent capabilities sequentially, enforcing strict safety guarantees and providing formatted audit reporting.

## Key Changes & Implementations

1. **Demo CLI Runner (`agent-core/scripts/demo.ts`)**:
   - Built a standalone TypeScript CLI script running via Node's native type stripping (`node --experimental-strip-types`).
   - **Step 1 — Imaging**: Generates a pure in-memory 256x256 grayscale PNG (using standard PNG signatures, `IHDR`, zlib-deflated `IDAT`, and `IEND` with CRC32) representing a synthetic chest X-ray. Authenticates as staff using environment credentials (`DEMO_STAFF_EMAIL` / `DEMO_STAFF_PASSWORD`) and uploads via `POST /api/media/upload`.
   - **Step 2 — Radar / Sepsis**: Generates an 8-reading deteriorating vitals sequence (HR rising from 80→150 BPM, SBP/DBP falling from 125/82→70/45 mmHg, temperature rising from 37.0→40.0°C, RR rising from 16→38 bpm, SpO2 falling from 98→88%) and posts it to the backend readings endpoints (`/api/intelligence/radar/sessions` + `/readings` and `/api/patient-app/:patientId/readings`).
   - **Step 3 — ECG**: Generates a synthetic 10-second 12-lead ECG signal array ($12 \times 1000$ finite numerical samples) and posts it to the backend ECG route (`POST /api/ecg/upload`).
   - **Step 4 — Dispatch**: Constructs a synthetic emergency SOS incident (`is_sos: true`, severity `CRITICAL`, location coordinates) and posts to the CAD dispatch API (`POST /api/incidents`).
   - **Step 5 — Code Blue**: Triggers an acute ventricular fibrillation resuscitation session via `POST /codeblue/start`, parses and logs the specialist consensus card (action, status, confidence, supporting specialists, rationale, warnings).
   - **Audit Polling & Timeout**: After each action, polls `GET /audit?since=...` (timeout default 90s, configurable via `--timeout`). Guaranteed non-hanging with clean fallback to `"timeout"`.
   - **Summary Table**: Concludes with an ASCII summary table detailing step number, workflow name, outcome (`executed`, `dry-run`, `review`, or `timeout`), audit record ID, and elapsed time in seconds.

2. **Safety & Patient Guard**:
   - `validatePatientId`: Refuses execution immediately if `patientId` does not start with `"DEMO-"` prefix.
   - All synthetic datasets (PNG, vitals, ECG, incident) are labelled as DEMO / synthetic data.

3. **CLI Flags**:
   - `--dry-run`: Prints method, URLs, headers, and payload summaries without dispatching any network calls.
   - `--only <step>`: Filters execution to a single step (`1`..`5` or name e.g. `imaging`, `radar`, `ecg`, `dispatch`, `codeblue`).
   - `--patient <id>`: Specifies demo patient ID (default `DEMO-P001`, enforces `DEMO-` prefix).
   - `--timeout <sec>`: Sets audit polling timeout in seconds (default: 90s).

4. **Environment Variables Configured**:
   - `BACKEND_URL`: MediCluster backend API URL (default: `http://localhost:5000`).
   - `DISPATCH_URL`: CAD ambulance dispatch API URL (default: `http://localhost:3001`).
   - `AGENT_URL`: Agent-Core HTTP URL (default: `http://localhost:8100`).
   - `AGENT_ADMIN_KEY`: Admin API key passed via `x-admin-key`.
   - `DEMO_STAFF_EMAIL`: Clinician email for demo login.
   - `DEMO_STAFF_PASSWORD`: Clinician password for demo login.

5. **Documentation**:
   - Documented the Demo Runner, environment variables, CLI options, and workflow steps in `agent-core/README.md`.

6. **Unit Tests (`agent-core/tests/demo.test.ts`)**:
   - 15 unit tests covering:
     - `DEMO-` guard (valid and invalid patient IDs, refusal without network calls)
     - `dry-run` sends nothing (verifying mocked `fetch` is never invoked and all steps report `dry-run`)
     - `timeout` path returns `"timeout"` not hang (mocked polling with empty responses and network errors settles within timeout window)
     - Summary table formatting (proper columns: `Step`, `Outcome`, `Audit ID`, `Seconds`)
     - Synthetic PNG, deteriorating vitals, 12-lead ECG, and SOS incident generator verification
     - CLI argument parsing
     - Full mocked execution flow

## Verification

- `agent-core/npm test`: 22 test files passed, 346 tests passed (100% pass rate).
- `agent-core/tsc --noEmit -p .`: Typecheck passed with 0 errors.
- `npm run demo -- --dry-run`: Ran all 5 steps in dry-run mode and printed summary table successfully.
