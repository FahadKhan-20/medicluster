# Sepsis Task Implementation Report (PhysioNet 2019 Challenge)

## Overview
Implemented the PhysioNet / CinC Challenge 2019 Early Sepsis Prediction system across the ML engine, Backend API proxy with agent authentication allowlist, and autonomous `agent-core` workflow with Jev decision-making and Gate safety enforcement.

---

## 1. Machine Learning Engine (`medicluster/ml-engine`)
- **Dataset**: PhysioNet / CinC Challenge 2019 (`training_setA` with 20,336 subjects + `training_setB` with 4,983 subjects) downloaded into `medicluster/ml-engine/data/sepsis2019/` (gitignored).
- **Feature Engineering**:
  - Patient-level forward fill of dynamic vitals (`HR, O2Sat, Temp, SBP, MAP, DBP, Resp`) and key laboratory values (`WBC, Lactate, Creatinine, Platelets, Glucose, BUN, pH`, etc.).
  - 6-hour rolling aggregations (mean, min, max, standard deviation, and 6-hour trend delta) for each clinical signal.
- **Model Training**:
  - Model: `scikit-learn` `HistGradientBoostingClassifier(class_weight='balanced', max_iter=150, learning_rate=0.08, max_depth=6)`.
  - Split: Patient-level 80/20 train/test stratified split over 11,000 subjects (8,800 train patients, 2,200 test patients).
  - Train dataset: 338,998 hourly rows (1.92% positive sepsis prevalence).
  - Test dataset: 84,585 hourly rows (1.91% positive sepsis prevalence).
  - Metrics:
    - **AUROC**: **0.7701**
    - **AUPRC**: **0.0787** (~4.1x above baseline positive rate of 1.91%)
  - Artifact: Saved to `medicluster/ml-engine/models_store/sepsis2019.joblib` (631 KB, gitignored).
- **Endpoint**: Added `POST /sepsis/score` in `medicluster/ml-engine/app.py`:
  - Input: `{ hours: [{ HR, O2Sat, Temp, SBP, MAP, DBP, Resp, WBC?, Lactate?, ... }] }` (chronological, $\ge 1$ row).
  - Output: `{ risk: float (0..1), band: "low"|"medium"|"high", top_factors: string[], model: "sepsis2019-hgb-v1" }`.
  - Strict input validation (400 on malformed payloads) and 503 response if model file is missing.

---

## 2. Backend Proxy & Agent Allowlist (`medicluster/backend`)
- **Proxy Route**: Added `POST /api/ml/sepsis/score` to `medicluster/backend/routes/mlRoutes.js` forwarding to the ML engine.
- **Agent Read Route**: Added minimal allowlisted read route `GET /api/ml/readings/:patientId` in `medicluster/backend/routes/mlRoutes.js` to gather historical vitals from the `Reading` model.
- **Route Allowlist**: Appended entries to `AGENT_ROUTES` in `medicluster/backend/middleware/auth.js`:
  - `{ method: "POST", pattern: /^\/api\/ml\/sepsis\/score$/ }`
  - `{ method: "GET", pattern: /^\/api\/ml\/readings\/[a-zA-Z0-9_-]{1,128}$/ }`

---

## 3. Autonomous Agent Workflow (`agent-core`)
- **Tool**: Added `src/tools/sepsis.ts` with tool `sepsis.score` (policy group `"sepsis"`), `fetchPatientReadings`, and `formatReadingsToHourlySequence` which buckets raw patient readings into a 12-hour hourly timeline.
- **Workflow**: Added `src/workflows/sepsis.ts` (`SepsisWorkflow`):
  - Ingests new vitals readings from patient app / backend `readings` collection.
  - Gathers last 12 hours of readings via `GET /api/ml/readings/:patientId`.
  - Calls `sepsis.score` for risk prediction and top factors.
  - Gemini builds fact-only state (risk is an objective numerical score/factor, never a diagnosis).
  - Jev scores urgency (`routine` | `urgent` | `critical`) and decides `alert` | `request_review` | `ignore`.
  - Treatment actions (prescribe/dose/diagnose) are guarded and never executed.
  - Safety & Gate enforcement: policy group `sepsis: auto` in `policy.yaml`, rate limit checking, kill switch re-check, idempotency deduplication, and structured audit trail (`Audit.start`, `step`, `finish`).
  - Clinician alert raised via `alerts.create` with code-owned severity (`CRITICAL`, `HIGH`, `WARNING`).
- **Wiring**: Registered `SepsisWorkflow` in `src/main.ts`.

---

## Files Modified and Created
- `medicluster/ml-engine/risk/sepsis_model.py` (New: training pipeline, feature extractor, scoring function)
- `medicluster/ml-engine/app.py` (Modified: registered `POST /sepsis/score`)
- `medicluster/ml-engine/tests/test_sepsis.py` (New: pytest suite for model and endpoint)
- `medicluster/backend/routes/mlRoutes.js` (Modified: added proxy and read route)
- `medicluster/backend/middleware/auth.js` (Modified: appended to `AGENT_ROUTES`)
- `medicluster/backend/tests/sepsisScore.test.js` (New: node --test suite with mocked engine)
- `agent-core/src/tools/sepsis.ts` (New: sepsis.score tool and readings formatter)
- `agent-core/src/workflows/sepsis.ts` (New: SepsisWorkflow implementation)
- `agent-core/src/main.ts` (Modified: registered SepsisWorkflow)
- `agent-core/policy.yaml` (Modified: added `sepsis: auto` group)
- `agent-core/tests/sepsisWorkflow.test.ts` (New: vitest suite with fakes and safety checks)
- `.gitignore` (Modified: ignored `medicluster/ml-engine/data/`, `models_store/`, `*.joblib`)

---

## Test Execution Summary
- **ML Engine Tests**:
  - `pytest medicluster/ml-engine/tests/test_sepsis.py medicluster/ml-engine/tests/test_clinical_knowledge.py medicluster/ml-engine/tests/test_advanced_ml_nlp_features.py`: **17 passed** in 3.66s.
- **Backend Tests**:
  - `node --test tests/sepsisScore.test.js tests/agentAccess.test.js`: **7 passed** in 292ms.
- **Agent Core Tests**:
  - `npx vitest run`: **11 test files passed**, **152 tests passed**, 0 failed in 743ms.
  - `npx tsc --noEmit -p .`: **Clean typecheck**, 0 errors.

---

## Items Left Undone
None. All components are implemented, tested, and committed according to specifications.
