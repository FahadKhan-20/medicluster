# Report: ECG Autonomous Workflow (PTB-XL / TorchECG)

## Overview
Autonomous implementation of 12-lead ECG analysis and clinical alerting workflow for MediCluster:
1. Downloaded PhysioNet PTB-XL 1.0.3 (100 Hz records) and trained a 1D-ResNet classifier for the 5 standard superclasses (`NORM`, `MI`, `STTC`, `CD`, `HYP`) using folds 1-8 for training, fold 9 for validation, and fold 10 for testing.
2. Built `POST /ecg/analyze` on the Python intelligence engine with strict shape validation (12x1000 mV), optional lead reordering, and missing checkpoint handling.
3. Added proxy route in backend (`POST /api/intelligence/ecg/analyze`), appended to `AGENT_ROUTES`, and created a minimal `EcgRecord` model (`ecgrecords` collection) with upload routes.
4. Added tool `ecg.analyze` and autonomous workflow `EcgWorkflow` in `agent-core` with Jev decision-making, Gate safety enforcement (`ecg: auto`), Gemini fact-only extraction, code-owned severity alerting via `alerts.create`, and complete audit logging.

---

## 1. Model Training & PTB-XL Evaluation

- **Dataset**: PhysioNet PTB-XL 1.0.3 (100 Hz, 12 leads, 10 seconds, 21,799 records).
- **Architecture**: `ECGResNet1D` in `medicluster/intelligence-engine/ecg_model.py` (1D-ResNet with Conv1D 12->64, 4 residual stages 64->128->256->256 with skip downsampling, global average pooling, and linear head).
- **Training Setup**:
  - Folds 1-8: Train (17,418 records)
  - Fold 9: Validation (2,183 records)
  - Fold 10: Test (2,198 records)
  - Loss: `BCEWithLogitsLoss`
  - Optimizer: `AdamW` (lr=1e-3, weight_decay=1e-4) with `CosineAnnealingLR`
  - Device: Local GPU (NVIDIA GeForce RTX 4050 6 GB)
- **Checkpoint**: Saved to `medicluster/intelligence-engine/checkpoints/ecg_ptbxl.pt` (gitignored).
- **Test Set (Fold 10) Results**:
  - **Macro-AUC**: **0.9057**
  - **NORM AUC**: **0.9422**
  - **MI AUC**: **0.9178**
  - **STTC AUC**: **0.9290**
  - **CD AUC**: **0.9190**
  - **HYP AUC**: **0.8205**

---

## 2. Intelligence Engine Endpoint (`POST /ecg/analyze`)

- **Implementation**: `medicluster/intelligence-engine/ecg.py`
  - Strict input shape validation: exactly 12 leads and 1000 samples per lead, numeric finite values only.
  - Optional `lead_order` parameter: verifies and normalizes all 12 standard leads (`I, II, III, aVR, aVL, aVF, V1..V6`).
  - Signal amplitude sanity checks with warnings for flatline or extreme values.
  - Missing checkpoint returns HTTP 503 (`Model checkpoint ecg_ptbxl.pt is missing`).
  - Returns `{ probabilities: { NORM, MI, STTC, CD, HYP }, top, model: "ecg-ptbxl-v1", warning? }`.
  - Registered blueprint in `app.py` and included `ecg.status()` in `GET /health`.
- **Unit Tests**: `medicluster/intelligence-engine/tests/test_ecg.py` (8 unit tests covering missing checkpoint, validation, synthetic signals, lead reordering, warnings, and real model inference).

---

## 3. Backend Proxy & Model

- **Files Modified / Added**:
  - `medicluster/backend/routes/intelligenceRoutes.js`: Added `['POST', /^\/ecg\/analyze$/]` to allowed routes.
  - `medicluster/backend/middleware/auth.js`: Appended `{ method: "POST", pattern: /^\/api\/intelligence\/ecg\/analyze$/ }` to `AGENT_ROUTES`.
  - `medicluster/backend/models/EcgRecord.js`: Minimal Mongoose/Supabase model for ECG records (collection `ecgrecords`).
  - `medicluster/backend/routes/ecgRoutes.js`: Upload and query routes for clinicians and emergency crew.
- **Backend Tests**:
  - `medicluster/backend/tests/ecg_intelligence.test.js`: Validates proxy forwarding, authentication, `AGENT_ROUTES` access, and error propagation.
  - `medicluster/backend/tests/ecg_record.test.js`: Validates ECG upload input validation.

---

## 4. agent-core Tool & Autonomous Workflow

- **Files Added / Modified**:
  - `agent-core/src/tools/ecg.ts`: Implemented `ecg.analyze` tool with argument validation and backend client invocation.
  - `agent-core/src/workflows/ecg.ts`: Implemented `EcgWorkflow`:
    - Handles ECG events with raw signal stripping prior to logging/LLM/Jev.
    - Executes `ecg.analyze` tool through Gate check.
    - Uses Gemini LLM to format fact-only state (strictly medical observation, MI probability is never treated as a diagnosis).
    - Jev decides action (`alert` | `review` | `ignore`), urgency (`routine` | `urgent` | `critical`), and `act_now`.
    - Safety Gate enforces policy group `"ecg: auto"`, threshold 0.9, rate limiting, and kill switch.
    - Re-checks kill switch and idempotency immediately before writes.
    - Code strictly owns alert severity (`routine` -> `WARNING`, `urgent` -> `HIGH`, `critical` -> `CRITICAL`).
    - Dispatches alerts via `alerts.create` tool (`/api/alerts/agent`).
    - Never executes treatment or diagnostic actions.
  - `agent-core/src/main.ts`: Added registration line for `EcgWorkflow`.
  - `agent-core/policy.yaml`: Added `ecg: auto` group.
- **Vitest Tests**: `agent-core/tests/ecg.test.ts` (10 tests with fakes covering happy path, urgency severity mapping, pre-analyzed records, Jev ignore/review branches, kill switch engagement, and backend downtime).

---

## 5. Test Output Summary

- **agent-core**:
  - `npx vitest run`: **11 test files passed, 153 tests passed (100%)**
  - `npx tsc --noEmit -p .`: **0 errors (clean compilation)**
- **medicluster/backend**:
  - `node --test tests/intelligence.test.js tests/ecg_intelligence.test.js tests/ecg_record.test.js`: **3 test suites passed, 3 tests passed**
- **medicluster/intelligence-engine**:
  - `pytest tests`: **35 tests passed, 0 failed**

---

## 6. Items Left Undone
None. All components across Python intelligence engine, backend gateway/models, and agent-core workflows are fully completed, tested, and integrated.
