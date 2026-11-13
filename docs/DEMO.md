# MediCluster — features and how to run each

## 0. Start everything

```bash
cd /home/vinay/medicluster
./scripts/start-all.sh          # starts all 8 services, waits, prints status
./scripts/start-all.sh status   # which ports are up
./scripts/start-all.sh stop     # stops what the script started
```

| Service | Port | Folder |
|---|---|---|
| MediCluster web app (all web apps) | 3000 | `medicluster/frontend` |
| Backend API | 5000 | `medicluster/backend` |
| ML engine (chest X-ray, sepsis) | 8080 | `medicluster/ml-engine` |
| Intelligence engine (ECG, radar, rhythm) | 8090 | `medicluster/intelligence-engine` |
| Brain MRI service | 8001 | `medicluster/brain-mri-service` |
| Dispatch API | 3001 | `ambulance-dispatch/backend/api` |
| Dispatch center + Crew app | 5174 | `ambulance-dispatch/frontend/dispatcher-dashboard` |
| Agent control room (agent-core) | 8100 | `agent-core` |

Logins:

| App | Sign in with |
|---|---|
| Clinicians | your MediCluster staff account at `/login` |
| Agent console | admin key = `AGENT_ADMIN_KEY` in `agent-core/.env` |
| Pharmacist | `pharmacist.central@medicluster.demo`, password `PHARMA_DEMO_PASSWORD` in `medicluster/backend/.env` |
| Courier | `+919999911101`, PIN `PHARMA_DEMO_COURIER_PIN` in the same file |

Reseed the pharmacy demo data:

```bash
cd medicluster/backend && node -r dotenv/config scripts/seedPharmacyDemo.js
```

---

## 1. The 7 apps

| App | URL | What to show |
|---|---|---|
| MediCluster | http://localhost:3000/login | Clinician workspace: patients, alerts, imaging, datasets |
| Patient app | http://localhost:3000/app | Medicines, readings, pharmacy orders, CliniQ |
| Dispatch center | http://localhost:5174/#/login | Incidents, ambulances, assignment, live map |
| Crew app | http://localhost:5174/#/driver/login | Shift, calls, live GPS synced with patient app and dashboard |
| Pharmacy portal | http://localhost:3000/pharmacy | Order queue, accept/prepare/ready, assign courier, stock |
| Courier view | http://localhost:3000/courier | Deliveries, live GPS, OTP handover |
| CliniQ | http://localhost:3000/cliniq | Every feature in one chat |

## 2. The autonomous agent (agent-core, :8100)

Jev (OpenRouter) decides and Gemini (via OmniRoute) executes. Every decision passes a safety gate:
it executes at confidence ≥ 0.90 and otherwise goes to Review. Treatment actions (prescribe, dose,
diagnose) are never executed, only suggested. There is a kill switch. Every step is audited in
Supabase.

| # | Agent | What it does by itself | How to demo |
|---|---|---|---|
| 1 | Imaging Scan Loop | New chest X-ray / brain MRI → analyse → risk → alert or review | Upload an X-ray in MediCluster → watch it appear in the console Live Audit Stream |
| 2 | Clinical Alerts | Raises and escalates alerts from findings | Console → Agents → Clinical Alerts; CliniQ: "Any critical alerts?" |
| 3 | Medication Reminders | Sends due medicine reminders | Patient app → reminders |
| 4 | Deterioration Radar | Forecasts patient deterioration from vitals | Push readings → console audit |
| 5 | Sepsis Watch | Scores sepsis risk from readings (PhysioNet 2019 model) | CliniQ: "Sepsis risk for P003" |
| 6 | ECG Interpretation | Classifies ECG rhythm | Upload an ECG record → audit |
| 7 | Code Blue War Room | Arrest rhythm → suggested shock/drug steps, clinician confirms | CliniQ: "Start Code Blue drill for DEMO-P001" |
| 8 | Ambulance Dispatch | Picks the nearest unit and recommends an assignment | CliniQ: "Nearest ambulance to MG Road, Bengaluru" |
| 9 | Self-Heal Engine | Detects a down service and restarts it (needs `DOCKER_HOST`) | Console → Agents (shows "not configured" without Docker) |
| 10 | Spec Builder | Turns a spec into a planned change | Console → Agents |
| 11 | Pharmacy Ops | Low-stock, stuck orders, refill suggestions | Console → Agents → Pharmacy Ops |

Console features (http://localhost:8100/console):
- Kill switch (Stop / Resume Agent)
- Live Audit Stream
- Review queue
- **Decision Replay**: open an audit to see each step
- Agents page with live status
- Rules and keys
- **Chat** group in the sidebar, which opens CliniQ inside the console

Scripted end-to-end agent demo:

```bash
cd agent-core && npm run demo
```

## 3. CliniQ chat (http://localhost:3000/cliniq, or Console → Chat)

One chat that operates every feature, with a visible **Agent Execution Trace** for each answer.
Actions need a **Confirm** click.

| Ask | Result |
|---|---|
| Nearest ambulance to MG Road, Bengaluru | Map with you + numbered units, distance and ETA |
| Any critical alerts? | Alert cards with Acknowledge (confirm) |
| Latest imaging findings for P001 | Imaging result card |
| Why did the agent alert on P072? | Decision Replay inline |
| Sepsis risk for P003 | Risk score card |
| Start Code Blue drill for DEMO-P001 | War-room card, clinician confirms |
| Which incidents are active? | Live dispatch incidents |
| Upload a chest X-ray image | Analysis in chat |

The sidebar has New chat and Quick asks. The Live Agent panel streams the agent's autonomous
decisions, and **Replay in chat** explains any of them.

## 4. Imaging accuracy (honest, test-set numbers)

| Model | All images | Confident subset |
|---|---|---|
| Chest X-ray (Kermany test, 624) | 84.1% accuracy, AUROC 0.958 | 91.7% on the 83% it answers; the rest → "Uncertain — refer to radiologist" |
| Brain MRI tumour type (Figshare test, 613) | 94.1% | 96.7% on 93% |

Non-chest images (blank, photos, brain MRI) are rejected as "Not a chest X-ray". All thresholds
were fitted on TRAIN only.

Rebuild the imaging artefacts:

```bash
cd medicluster/ml-engine && ../intelligence-engine/.venv/bin/python -m datasets.split_identifiable && ../intelligence-engine/.venv/bin/python -m datasets.build_ood_gate
cd ../brain-mri-service && .venv/bin/python benchmark.py
```

Limitation to state: brain "is there a tumour?" is not validated, because the dataset has no healthy scans.

## 5. Pharmacy chain (live)

Prescribe → patient orders delivery → pharmacist accepts, prepares, marks ready, assigns courier →
courier accepts, picks up, shares live GPS → patient sees courier on map + OTP → courier delivers
with OTP → courier GPS hidden.

Run the whole chain against your local servers in about 5 seconds:

```bash
cd medicluster/backend && node scripts/pharmacyLiveChain.js P001
```

## 6. Tests

```bash
cd agent-core && npm test                                   # 392
cd medicluster/backend && npm test                          # 342
cd medicluster/frontend && npm test && npx playwright test  # 92 + browser
cd ambulance-dispatch/backend/api && npm test               # 21
cd ambulance-dispatch/frontend/dispatcher-dashboard && npm test
cd medicluster/ml-engine && ../intelligence-engine/.venv/bin/python -m pytest -q tests/
```

## 7. Five-minute jury run

1. **Console** (:8100): "This agent runs on its own." Show the kill switch, the live audit stream and one Decision Replay.
2. **Imaging**: upload a chest X-ray in MediCluster. It appears in the audit; uncertain cases are referred, not guessed.
3. **CliniQ**: Console → Chat → *Nearest ambulance*, then *Critical alerts*, then *Code Blue drill*. Point at the trace and the Confirm buttons.
4. **Dispatch + Crew**: :5174 shows the same ambulances live.
5. **Pharmacy**: run `pharmacyLiveChain.js`, then show the order in `/pharmacy` and the courier in `/courier`.
6. Close on safety: confidence gate, suggest-only treatment, full audit, kill switch.
