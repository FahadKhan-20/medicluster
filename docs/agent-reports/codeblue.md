# MediCluster Code Blue Resuscitation War Room — Engineering Report

## Executive Summary
Autonomous implementation of the **Code Blue Resuscitation War Room** (demo version, advisory only), featuring:
1. **1D-CNN Arrest Rhythm Classifier** trained on PhysioNet CUDB and VFDB datasets (`arrest-rhythm-v1`).
2. **ACLS Resuscitation Session Engine** with 2-minute CPR cycle tracking, shock protocols, epinephrine, and amiodarone sequencing.
3. **Tri-Specialist Agent Architecture** (Intensivist, Pharmacologist, Cardiologist) with Gemini clinical rationale synthesis.
4. **Jev-Powered Consensus Engine** adhering to strict safety gates, kill-switch rechecks, and audit logging. Invariant: **NEVER auto-executes**; every card carries `"Suggested — clinician confirms"`.
5. **Simulated Monitor Feed** generating continuous 250 Hz single-lead ECG waveforms across clinical stages (`VF → Shock 1 → VF → Epinephrine → Shock 2 → ROSC`).
6. **Trauma-Bay Real-Time Dashboard** served directly at `GET /codeblue` with high-contrast oscilloscope canvas and responsive controls.

---

## 1. Arrest Rhythm Model Evaluation Metrics

- **Training Data**: Open PhysioNet CU Ventricular Tachyarrhythmia Database (`cudb`, 35 records) and MIT-BIH Malignant Ventricular Ectopy Database (`vfdb`, 22 records).
- **Windows**: 4-second single-lead windows at 250 Hz (1,000 samples per window).
- **Classes**:
  - `VF`: Ventricular Fibrillation & Flutter
  - `VT`: Ventricular Tachycardia
  - `ASYSTOLE`: Flatline with physiological drift & low-amplitude noise
  - `ORGANIZED`: Normal Sinus Rhythm & supraventricular rhythms
- **Architecture**: 4-layer 1D-CNN with residual skip downsamplers, LeakyReLU activations, BatchNorm, and Adaptive Average Pooling.

### Test Split Results (Held-Out Test Set):
| Rhythm Class | Precision | Recall | F1 Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| **VF** (Ventricular Fibrillation) | 0.7808 | 0.8212 | **0.8005** | 386 |
| **VT** (Ventricular Tachycardia) | 0.8135 | 0.7811 | **0.7970** | 402 |
| **ASYSTOLE** (Flatline) | 0.9846 | 0.9770 | **0.9808** | 392 |
| **ORGANIZED** (Sinus/SVT) | 0.9499 | 0.9476 | **0.9487** | 420 |
| **Overall Accuracy** | — | — | **0.8825** | 1,600 |
| **Macro Average F1** | — | — | **0.8818** | 1,600 |

*Checkpoint is saved locally at `medicluster/intelligence-engine/arrest_rhythm.pt` and is gitignored.*

---

## 2. Architecture & Design Decisions

### A. Specialist Decision Layer
- **Intensivist Agent** (`src/codeblue/specialists.ts`):
  - Pure ACLS rule engine based on 2020/2023 AHA ACLS Guidelines constants in `src/codeblue/acls.ts`.
  - Prompts 2-minute CPR cycle rhythm/pulse checks.
  - Shockable pathway: Defibrillation 200 J biphasic; Epinephrine 1 mg every 3–5 min starting after Shock 2; Amiodarone 300 mg bolus after Shock 3, 150 mg after Shock 5.
  - Non-shockable pathway: Epinephrine 1 mg ASAP, repeat every 3–5 min; investigate reversible 5 H's and 5 T's.
  - ROSC pathway: Transitions immediately to Post-Cardiac Arrest Care.
- **Pharmacologist Agent** (`src/codeblue/specialists.ts`):
  - Implements the race-free **CKD-EPI 2021** formula for eGFR calculation (`src/codeblue/egfr.ts`).
  - Matches patient allergies (e.g., documented Iodine / Amiodarone allergy).
  - Consults curated interaction table JSON (`src/codeblue/interactions.json`) for resus drugs.
  - Issues **Pharmacologist Veto** on allergy match, automatically recommending Lidocaine 1.0–1.5 mg/kg IV/IO substitution.
  - Issues high-severity warnings for Epinephrine with concurrent beta-blockers (unopposed alpha-1 vasoconstriction).
- **Cardiologist Agent** (`src/codeblue/specialists.ts`):
  - Consumes `/rhythm/classify` predictions and parallel `/ecg/analyze` contract.
  - Validates rhythm shockability and provides automated diagnostic confidence.
- **Gemini Clinical Rationale**:
  - LLM writes only a concise one-line plain-language summary of the clinical picture.
  - Soft-fails safely to deterministic template rationale if offline.

### B. Consensus & Gate Safety
- **Jev Consensus** (`src/codeblue/consensus.ts`):
  - Formulates candidate actions as a Jev `choice` question + Jev `noul` agreement.
  - Resolves specialist differences and prioritizes pharmacologist safety vetos.
  - Generates `Consensus Action Card` with supporting agents, conflicts, warnings, and countdowns.
  - Status is **strictly** `"Suggested — clinician confirms"`.
  - Validates against `Gate` (kill switch, rate limits, clinical action review).
  - Audits every generated card via `Audit.start` / `append` / `finish("review")`.

### C. Clinician Acknowledgement
- Clinician clicks "Confirm Action" or calls `POST /codeblue/:id/ack`.
- Audited with outcome `"executed"` under clinician identity.
- Advances code blue internal state (increments shock count, records epinephrine timestamp, updates cycle).

---

## 3. Files Created & Modified

### Created Files:
- `medicluster/intelligence-engine/.gitignore` (ignores `.venv`, `data/`, `*.pt`)
- `medicluster/intelligence-engine/download_rhythm_data.py` (parallel curl downloader for PhysioNet CUDB and VFDB)
- `medicluster/intelligence-engine/train_rhythm.py` (PyTorch 1D-CNN training & F1 evaluation pipeline)
- `medicluster/intelligence-engine/rhythm.py` (Flask `/rhythm/classify` blueprint & inference engine)
- `medicluster/intelligence-engine/tests/test_rhythm.py` (Pytest test suite for rhythm model & HTTP endpoint)
- `medicluster/backend/tests/rhythmProxy.test.js` (Node test for backend proxy & agent allowlist)
- `agent-core/src/codeblue/acls.ts` (AHA ACLS constants & source comments)
- `agent-core/src/codeblue/egfr.ts` (CKD-EPI 2021 race-free eGFR formula & CKD staging)
- `agent-core/src/codeblue/interactions.json` (Curated drug interaction & allergy database)
- `agent-core/src/codeblue/interactions.ts` (Drug safety & veto engine)
- `agent-core/src/codeblue/clients.ts` (Adapters for rhythm classification & 12-lead ECG analysis)
- `agent-core/src/codeblue/specialists.ts` (Intensivist, Pharmacologist, Cardiologist agents & Gemini rationale)
- `agent-core/src/codeblue/consensus.ts` (Jev consensus decider, gate verification, audit logging)
- `agent-core/src/codeblue/simulator.ts` (Scripted monitor scenario `VF → shock → VF → epi → ROSC` with 250 Hz waveforms)
- `agent-core/src/codeblue/session.ts` (Session state manager, real-time timers, clinician ack, engine)
- `agent-core/src/codeblue/ui.ts` (Full-screen trauma-bay dashboard with HTML5 canvas rhythm strip)
- `agent-core/src/codeblue/routes.ts` (HTTP API routes `/codeblue/*`)
- `agent-core/tests/codeblue.test.ts` (Vitest test suite: 23 tests)

### Modified Files:
- `medicluster/backend/middleware/auth.js` (appended `POST /api/intelligence/rhythm/classify` to `AGENT_ROUTES`)
- `medicluster/backend/routes/intelligenceRoutes.js` (added `POST /rhythm/classify` to allowed worker routes)
- `medicluster/intelligence-engine/app.py` (registered `rhythm.bp`)
- `agent-core/src/api/server.ts` (delegated `/codeblue/*` routes to `handleCodeBlueRoute`)
- `agent-core/src/main.ts` (one registration line wiring `CodeBlueEngine` into `createServer`)

---

## 4. Test Verification Summary

1. **`agent-core` Vitest**:
   - `11` test files passed (`166` tests passed).
   - `tests/codeblue.test.ts`: **23 passed** covering:
     - ACLS rule timings (2-min CPR cycles, rhythm checks, shock sequencing, Epi & Amiodarone timing, ROSC).
     - eGFR via CKD-EPI 2021 (normal, mild, moderate, severe stages, validation errors).
     - Pharmacologist allergy veto (iodine/amiodarone veto -> Lidocaine substitution) and drug interactions (beta-blockers, QT drugs).
     - Consensus card shape, advisory-only status, audit trail, and gate rechecks.
     - Simulator waveforms across 5 clinical phases.
     - HTTP API routes (`GET /codeblue`, `POST /codeblue/start`, `GET /codeblue/:id/card`, `POST /codeblue/:id/ack`, `POST /codeblue/:id/stop`).
2. **`agent-core` TypeScript**:
   - `npx tsc --noEmit -p .` completed cleanly with **0 errors**.
3. **`medicluster/backend` Node Test**:
   - `node --test tests/rhythmProxy.test.js` passed (**1 test passed**; verifies proxy routing, agent token allowlist, clinician token handling).
   - `node --test tests/agentAccess.test.js` passed (**5 tests passed**).
4. **`medicluster/intelligence-engine` Pytest**:
   - `PYTHONPATH=. .venv/bin/pytest tests/test_rhythm.py` passed (**6 tests passed**).

---

## 5. Anything Left Undone
None. All components specified in the task description have been fully designed, implemented, integrated, and verified against tests.
