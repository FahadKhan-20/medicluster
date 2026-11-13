# CliniQ MediCluster Agent Tool Catalog Report

## Overview
The MediCluster Agent (CliniQ) tool catalog has been extended so every platform feature is reachable by role-authorized users. All tool executions strictly adhere to security, role scoping, and privacy boundaries. Mutations and state-changing tools require explicit user confirmation through the action card receipt flow (`isAction` / `write: true`). In addition, `POST /api/cliniq/chat?stream=1` supports Server-Sent Events (SSE) streaming per-step tool lifecycle events (`start`/`end`, tool `name`, short `argsSummary`, and `resultSummary`) to provide live UI progress, while keeping the non-stream JSON response format completely unchanged.

---

## Complete Tool Catalog

The platform catalog contains 45 distinct tools:

| Tool Name | Roles | Type | Description | Page Links |
| :--- | :--- | :--- | :--- | :--- |
| **nearby_ambulances** | Patient, Clinician | Read | Nearest available ambulances with distance/ETA via dispatch API | `/dispatch` |
| **active_incidents** | Clinician | Read | Active dispatch incidents with severity, assigned unit, and status | `/dispatch` |
| **incident_status** | Clinician | Read | Detailed incident view with crew coordinates and timeline | `/dispatch` |
| **my_emergency_status** | Patient | Read | Active emergency status, assigned crew GPS & ping (omits GPS when closed) | `/app/emergency` |
| **dispatch_ambulance** | Clinician (Dispatcher/Admin) | **Action** | Assign ambulance to an incident | `/dispatch` |
| **list_alerts** | Clinician | Read | List clinical/patient alerts with unread/critical/patient filter | `/alerts` |
| **acknowledge_alert** | Clinician | **Action** | Acknowledge clinical alert | `/alerts` |
| **ecg_records** | Clinician | Read | 12-lead ECG records for a patient | `/dashboard` |
| **interpret_ecg** | Clinician | Read | PTB-XL model inference output via intelligence ECG route | `/dashboard` |
| **sepsis_risk** | Clinician | Read | Sepsis risk score, band, and top factors via ml-engine | `/clinical-ai` |
| **start_code_blue** | Clinician | **Action** | Initiate Code Blue resuscitation consensus session | `/codeblue` |
| **agent_status** | Clinician (Admin) | Read | MediCluster autonomous agent health and runtime status | `/agent` |
| **agent_recent_decisions** | Clinician (Admin) | Read | Recent agent decisions and audit trail with type/patient filters | `/agent` |
| **explain_agent_decision** | Clinician (Admin) | Read | Plain-language explanation: event, Jev probabilities, gate verdict, tools, outcome | `/agent` |
| **agent_stop** | Clinician (Admin) | **Action** | Stop the autonomous agent loop | `/agent` |
| **agent_start** | Clinician (Admin) | **Action** | Start/resume the autonomous agent loop | `/agent` |
| **imaging_findings_summary** | Clinician | Read | Summarize latest findings across scans in plain language with review status | `/imaging`, `/brain-explorer` |
| **features** | Patient, Clinician | Read | List features available in current app and how to use them | App-dependent |
| **navigate** | Patient, Clinician | Read | Open a feature in current app | App-dependent |
| **find_patients** | Clinician | Read | Search patients by name or exact ID; requires selection on ambiguity | `/patient` |
| **patient_record** | Patient, Clinician | Read | Read profile or clinical record for authorized patient | `/patient` |
| **patient_resources** | Patient, Clinician | Read | List readings, appointments, documents, reminders, or emergencies | `/patient` |
| **nearby_hospitals** | Patient, Clinician | Read | Find nearby hospitals using shared coordinates or city | `/hospitals` |
| **dashboard** | Clinician | Read | Read datasets, cluster results, alerts, hospitals, ambulances, dispatch history | `/dashboard` |
| **imaging_records** | Clinician | Read | List patient images and analysis findings | `/imaging` |
| **analyze_image** | Clinician | Read | Analyze patient image with chest or brain MRI model | `/imaging` |
| **imaging_models** | Clinician | Read | List available imaging models | `/imaging` |
| **imaging_action** | Clinician | Read/Action | Record analyzed image, flag review, or generate Grad-CAM heatmap | `/imaging` |
| **brain** | Clinician | Read | Read actor-owned MRI studies, study details, or compare studies | `/brain-explorer` |
| **brain_action** | Clinician | Read/Action | Create demo, point-guided segmentation, or slice classification | `/brain-explorer` |
| **radar** | Clinician | Read | Deterioration radar observation sessions and reference scores | `/deterioration-radar` |
| **radar_action** | Clinician | Read/Action | Create session, append vitals, advance demo, or forecast | `/deterioration-radar` |
| **run_clustering** | Clinician | Read | Run clustering algorithm (kmeans, dbscan, hierarchical, gmm) on dataset | `/dashboard` |
| **clinical_analysis** | Clinician | Read | Clinical notes, symptom extraction, drug interactions, MEWS, NEWS2 | `/clinical-ai` |
| **advanced_analysis** | Clinician | Read | Advanced Clinical AI models (risk profiles, vital forecast, anomaly detection, etc.) | `/clinical-ai` |
| **update_profile** | Patient, Clinician | Read/Action | Update authorized patient profile information or emergency contact | `/app/profile` |
| **book_appointment** | Patient, Clinician | Read/Action | Propose patient appointment booking | `/app/visits` |
| **change_appointment** | Patient, Clinician | Read/Action | Reschedule or cancel existing appointment | `/app/visits` |
| **appointment_status** | Clinician | **Action** | Confirm or complete an appointment | `/app/visits` |
| **log_reading** | Patient, Clinician | Read/Action | Record blood pressure, glucose, or weight measurement | `/app/health/log` |
| **create_reminder** | Patient, Clinician | Read/Action | Create prescribed medication reminder schedule | `/reminders` |
| **change_reminder** | Patient, Clinician | Read/Action | Activate, deactivate, or delete medication reminder | `/reminders` |
| **edit_reminder** | Patient, Clinician | Read/Action | Edit reminder schedule and prescribed dosage | `/reminders` |
| **log_dose** | Patient, Clinician | Read/Action | Log dose taken for scheduled reminder | `/reminders` |
| **send_sos** | Patient | **Action** | Submit emergency SOS request using verified pickup coordinates | `/app/emergency` |

---

## Live Tool Progress Streaming (SSE)

### Endpoint
`POST /api/cliniq/chat?stream=1`

### Behavior
- When `?stream=1` is provided, the endpoint streams Server-Sent Events (`Content-Type: text/event-stream`).
- Each tool step emits lifecycle events:
  - `event: tool_start`:
    ```json
    { "step": "start", "phase": "start", "type": "tool_start", "name": "list_alerts", "tool": "list_alerts", "argsSummary": "filter: unread" }
    ```
  - `event: tool_end`:
    ```json
    { "step": "end", "phase": "end", "type": "tool_end", "name": "list_alerts", "tool": "list_alerts", "resultSummary": "1 items", "error": null }
    ```
  - `event: done`: Emits final assistant response object with `reply`, `results`, `actions`, `links`, and `role`.
- When `?stream=1` is omitted, the response remains normal JSON (`application/json`), preserving backward compatibility.

---

## Security & Verification Summary

1. **Role Scoping & Access Control:**
   - Patient cannot invoke any clinician or dispatch/agent control tools.
   - Non-admin clinician cannot invoke agent control tools (`agent_status`, `agent_recent_decisions`, `explain_agent_decision`, `agent_stop`, `agent_start`).
   - Non-dispatcher clinician cannot invoke `dispatch_ambulance`.
   - Arguments from model outputs cannot forge actor ID, role, or credentials.

2. **Actions & Approvals:**
   - All state-changing tools (`write: true`) propose an action receipt card. The agent orchestrator returns instructions for user confirmation rather than auto-executing.

3. **Privacy:**
   - Patient can only query their own emergency (`s.patientId`).
   - Closed, resolved, or cancelled emergencies omit crew GPS coordinates.

4. **Resilience:**
   - Upstream service failures (dispatch, ml-engine, agent core) return sanitized 503 friendly errors without exposing internal provider stacks.

5. **Test Status:**
   - 286 / 286 backend tests passing (`node --test tests/*.test.js`).
