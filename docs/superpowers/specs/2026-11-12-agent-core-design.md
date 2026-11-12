# Agent Core: Design Spec

Date: 2026-11-12
Status: Approved in brainstorming, awaiting written-spec review
Sub-project: 1 of 5 (MediCluster Autonomous Agent)

## 1. Context and goal

MediCluster already has CliniQ, a chat assistant with role-scoped tools. CliniQ acts only when a user asks, and it has no dispatch (CAD) write access.

The long-term product is one autonomous agent that operates every MediCluster feature (dashboard, alerts, imaging, 3D tumor explorer, deterioration radar, patients, reminders, reports, CliniQ, clinical AI, hospitals, dispatch). It also self-heals the platform, builds features and fixes bugs. The work is split into five sub-projects:

1. **Agent Core** (this spec): runtime, events, decision layer, tools, control, audit, plus one proving workflow (imaging).
2. Operator coverage: tool groups for the remaining pages, including dispatch.
3. Self-heal: health monitoring, restart and rollback ladder, protected dispatch/SOS fallback.
4. Builder: feature and bug pipeline (code, test, canary deploy, auto-rollback).
5. Command Center: UI for live agent view, chat commands, kill switch and audit replay.

### Goal of this sub-project

Deliver a running `agent-core` service that reacts to new imaging uploads without human input. Jev decides what to do and whether it is safe to do it. The service executes the decision through MediCluster's existing APIs and records a full audit trail. A human can stop it at any time.

### Success criteria

- A synthetic scan uploaded in Docker Compose is analyzed and, when Jev is confident, produces an alert with no human click.
- A low-confidence decision produces a doctor review request instead of an alert.
- Every decision appears in the audit log with Jev's probabilities.
- The kill switch stops new actions mid-run, and queued events resume after restart.
- All new tests pass, and the existing backend suite (230 tests) still passes.

## 2. Decisions made

| Topic | Decision |
|---|---|
| Location | New service at `/home/vinay/medicluster/agent-core/`, TypeScript, own Docker container |
| Agent shape | One main agent; each MediCluster page becomes a tool group, not a separate agent |
| Decision model | **Jev** (`typesafe/jev-1.13`, OpenRouter decisions endpoint) makes every decision |
| Execution model | **Gemini 3.8 Flash** through OmniRoute, the same setup CliniQ uses; behind a provider interface so it can be swapped |
| Events | Supabase Realtime on `public.medicluster_records`, plus a health poller |
| Writes | Only through existing MediCluster HTTP APIs, as a new `agent` service identity |
| Runtime | Docker Compose; agent-core added as a service |
| First workflow | Imaging |
| Treatment actions | Prescribing, dose changes and diagnosis always stay at `suggest` (doctor confirms). This keeps MediCluster out of autonomous medical-device territory |

## 3. Architecture

```
agent-core/
  src/
    events/    Realtime listener + catch-up reader + health poller -> typed events
    agent/     main loop: event -> state -> Jev decision -> rules -> execute -> audit
    judge/     Jev client (TypeScript port of context-selection-engine/cse/jev.py)
    llm/       provider interface + OmniRoute/Gemini implementation
    tools/     tool groups calling MediCluster APIs (v1: imaging, alerts)
    control/   policy loader, autonomy gate, hard rules, kill switch
    audit/     audit writer (collection agent_audit)
    api/       HTTP API: /health, /command, /audit, /control/stop, /control/start
    config.ts  env parsing and validation
  policy.yaml
  Dockerfile
  tests/
```

### 3.1 Role split

| Responsibility | Jev | Gemini 3.8 Flash |
|---|---|---|
| Choose the action for an event | yes (`choice`) | no |
| Rate urgency | yes (`score`) | no |
| Decide whether acting now is safe and correct | yes (`noul`) | no |
| Turn raw event data into a clean state (facts only) | no | yes |
| Fill tool arguments for the chosen action | no | yes |
| Write alert text and summaries | no | yes |

Gemini never chooses an action. If Gemini output contradicts Jev's chosen action (for example, it calls a different tool), the loop rejects it and records the mismatch.

### 3.2 Main loop (per event)

1. The event arrives with an idempotency key: `<event id>:<action>`.
2. The kill switch is checked. If stopped, the event is queued and the loop goes no further.
3. Gemini builds the **state**: patient ID, modality, model findings, scan metadata. Facts only, no recommendations.
4. Jev receives the state and these questions:
   - `action` (`choice`): `analyze`, `alert`, `request_review`, `ignore`
   - `urgency` (`score`): `routine`, `urgent`, `critical`
   - `act_now` (`noul`): "acting now on the chosen action is safe and correct"
5. **Autonomy gate:** execute only if the tool group's level is `auto`, the chosen action's probability ≥ the threshold, and `act_now` ≥ the threshold. Otherwise create a review request carrying Jev's top options.
6. **Hard rules** run (section 4.2). A violation blocks execution and is audited.
7. Gemini fills arguments, and the tool executes through the API.
8. The audit entry is written: event, state, Jev questions and answers, gate result, tool calls, outcome, timings.

The imaging workflow runs two decision rounds: the first decides whether to analyze a new upload, and the second decides alert, review or ignore once findings exist.

### 3.3 Events

- Subscribe to `public.medicluster_records` changes with Supabase Realtime.
- Map `collection = 'patientmedias'` inserts to `scan.uploaded`, and analysis updates to `scan.analyzed`.
- **Catch-up:** on start and after every reconnect, call the existing `mc_find` RPC for `patientmedias` documents whose `data.updatedAt` is later than the last processed timestamp. The table has no timestamp column; `updatedAt` is written by the model layer (`timestamps: true`). The last processed timestamp is stored in collection `agent_state`.
- The health poller checks `/api/health`, ML `/health` and the intelligence engine on an interval and emits `service.down` / `service.up`. In v1 these events only gate imaging retries; restart behavior belongs to sub-project 3.

**Realtime access (required migration):** `medicluster_records` currently revokes all table privileges from `service_role`, and all access goes through RPCs. Realtime `postgres_changes` needs table-level `SELECT` for the subscribing role. A new migration adds `medicluster_records` to the `supabase_realtime` publication. It also grants `SELECT` (read only) on that table to `service_role`. No write grant is added: writes stay behind the APIs. If the project owner rejects the grant, the fallback is catch-up polling every 5 seconds through `mc_find`, using the same code path.

### 3.4 Tools (v1)

All calls go to the MediCluster backend with the agent token.

| Tool | API |
|---|---|
| `imaging.list_models` | `GET /api/media/models` |
| `imaging.analyze` | `POST /api/media/analyze/:fileId` |
| `imaging.request_review` | `POST /api/media/review/:fileId` |
| `alerts.create` | `POST /api/alerts/agent` (new) |

Each tool has a JSON schema for arguments, validated before the call.

### 3.5 Backend changes (medicluster/backend)

- **Agent identity:** a service token signed with a separate secret (`AGENT_JWT_SECRET`), with `role: "agent"`. `requireAuth` accepts it only on an explicit allowlist of routes (the four above). Every other route returns 403 for this role.
- **Agent alerts:** today alerts are derived from cluster results, reminders and media. A new collection `agentalerts` stores alerts the agent creates. `POST /api/alerts/agent` writes one (fields: patient_id, source_id, severity, title, summary, jev_probabilities, audit_id). `GET /api/alerts` merges them into its existing response, marked `source: "agent"`. Acknowledgement uses the existing `/api/alerts/ack`.
- Existing behavior is unchanged for clinician and patient tokens.

### 3.6 Jev client port

- Port `noul`, `choice`, `score` builders, `decide()`, and `fallback_answer` from `cse/jev.py`.
- Call OpenRouter's decisions endpoint with `JEV_MODEL` (default `typesafe/jev-1.13`) and `OPENROUTER_API_KEY`.
- On any error or timeout, return the neutral fallback: `noul` 0.5, `choice` uniform with confidence 0, `score` uniform. Fallback answers always fall below the threshold, so they never execute.
- Track cost per call in the audit entry.

## 4. Control and safety

### 4.1 Policy (`policy.yaml`)

```yaml
threshold: 0.9
groups:
  imaging: auto
  alerts: auto
  # all other groups absent = off
rate_limit_per_minute: 30
```

Levels: `off` (tool disabled), `suggest` (always create a review request), `auto` (execute when the gate passes, otherwise suggest). The file is reloaded on change. An invalid file keeps the last valid policy and logs an error.

### 4.2 Hard rules (code, not configurable by the model)

- No delete operations in v1.
- Rate limit per tool group per minute.
- Idempotency: an action key that already succeeded is never executed again.
- Treatment actions (prescribe, dose, diagnose) are forced to `suggest`.
- The kill switch overrides every level.

### 4.3 Kill switch

`POST /control/stop` sets the stopped flag. A tool call already running completes, no new actions start, and new events are queued in `agent_state`. `POST /control/start` resumes and drains the queue. The flag survives restarts. Control endpoints require an admin key (`AGENT_ADMIN_KEY`).

### 4.4 Audit

Collection `agent_audit` in `medicluster_records`. One entry per event, appended as the loop progresses. `GET /audit?since=&limit=` reads entries. The agent cannot delete or edit audit entries: it writes them through `mc_write` inserts only.

## 5. Error handling

| Failure | Behavior |
|---|---|
| Gemini/OmniRoute down or times out | 2 retries with backoff, then the event is marked `pending` and retried later; no action taken |
| Jev fails | Neutral fallback, which is below threshold, so the result is at most a review request |
| Backend 5xx | Retry with backoff (max 3), then mark `failed` in audit |
| Backend 4xx | No retry; mark `failed` with the reason |
| Imaging worker offline | Mark `analysis_unavailable`; retry on `service.up` |
| Realtime disconnect | Reconnect with backoff, then run catch-up |
| agent-core crash | Docker restart policy; catch-up plus idempotency prevent duplicates |

## 6. Testing

**Unit (Vitest, no network):**
- Jev client: request shapes for each question type. It returns the fallback on errors and never throws. It matches `cse/jev.py` output for the same mocked responses.
- Autonomy gate: ≥ threshold executes, < threshold goes to review, fallback never executes, kill switch blocks everything.
- Hard rules: rate limit, idempotency, treatment forced to suggest, no deletes.
- Event mapper and catch-up: correct event types; already-processed events are skipped.
- Tools: correct paths, agent token attached, 4xx stops and 5xx retries.
- Gemini/Jev mismatch: a tool call that differs from Jev's choice is rejected.

**Integration (fake Jev and Gemini, mock backend over HTTP):**
- Scan uploaded, analyzed, Jev critical at 0.95: alert created and audit entry complete.
- Jev at 0.6: review request created, no alert.
- Gemini down: event pending, nothing executed, processed after recovery.
- Imaging worker offline: marked unavailable, retried on `service.up`.

**Backend suite:**
- The agent token can reach only the four allowlisted routes; every other route returns 403.
- `POST /api/alerts/agent` validation, and the merge into `GET /api/alerts`.
- The existing 230 tests still pass.

**Live smoke (manual, synthetic data only):**
- In Docker Compose with real Gemini and Jev, upload a synthetic X-ray for a demo patient and check the audit feed.
- Never run against real patient records.

## 7. Out of scope for this sub-project

- Tool groups for any page other than imaging and alerts.
- Dispatch control.
- Restarting or redeploying services (sub-project 3).
- Code generation and deployment (sub-project 4).
- Any UI beyond the HTTP API (sub-project 5).
- Multi-agent orchestration (the product uses one main agent).

## 8. Configuration

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Realtime subscription and catch-up reads |
| `BACKEND_URL` | MediCluster backend base URL |
| `AGENT_JWT_SECRET` | Signs the agent service token (shared with the backend) |
| `AGENT_ADMIN_KEY` | Protects the control endpoints |
| `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, `AGENT_MODEL` | Gemini through OmniRoute (same variable names as CliniQ; default route `agy/gemini-3.8-flash-medium`) |
| `OPENROUTER_API_KEY`, `JEV_MODEL` | Jev decisions |
| `AGENT_PORT` | HTTP API port (default 8100) |
