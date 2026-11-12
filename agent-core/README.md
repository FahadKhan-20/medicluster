# agent-core

Autonomous MediCluster agent. Jev makes every decision; Gemini (via OmniRoute) only fills in text. All MediCluster writes go through authenticated backend routes. Only `agent_audit` and `agent_state` are written directly.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | | Supabase project URL |
| `SUPABASE_SECRET_KEY` | yes | | Secret key for `mc_find` / `mc_write` |
| `BACKEND_URL` | yes | | MediCluster backend, e.g. `http://backend:5000` |
| `AGENT_JWT_SECRET` | yes | | At least 32 chars; must equal the backend's `AGENT_JWT_SECRET` |
| `AGENT_ADMIN_KEY` | yes | | Value for the `x-admin-key` header |
| `OPENROUTER_API_KEY` | yes | | Jev decisions |
| `JEV_MODEL` | no | `typesafe/jev-1.13` | |
| `OMNIROUTE_URL` | no | `http://localhost:20128` | Gemini gateway |
| `OMNIROUTE_API_KEY` | no | | |
| `AGENT_MODEL` | no | `agy/gemini-3.8-flash-medium` | |
| `ML_URL` | no | `http://ml-engine:8000` | Health polling |
| `INTEL_URL` | no | `http://intelligence-engine:8090` | Health polling |
| `AGENT_PORT` | no | `8100` | HTTP port |
| `POLICY_PATH` | no | `policy.yaml` | Hot-reloaded autonomy policy |

## Run

```
npm ci
npm test
npm run build
node dist/main.js
```

With Docker Compose (needs Node 22 for Supabase Realtime), from the repo root:

```
AGENT_JWT_SECRET=... AGENT_ADMIN_KEY=... OPENROUTER_API_KEY=... docker compose -f medicluster/docker-compose.yml up agent-core
```

### Self-Healing Mode (Opt-in)

To enable autonomous container self-healing, run with the `docker-compose.selfheal.yml` override:

```
docker compose -f medicluster/docker-compose.yml -f medicluster/docker-compose.selfheal.yml up
```

This starts a secure `docker-proxy` service using `tecnativa/docker-socket-proxy:0.1.1` with a read-only Docker socket mount (`/var/run/docker.sock:ro`) and restricted permissions (`CONTAINERS=1` and `POST=1` only). `agent-core` connects securely over TCP via `DOCKER_HOST=tcp://docker-proxy:2375`.

## HTTP API

`GET /health` is public. Everything else needs `x-admin-key`; a missing or wrong key returns 401.

```
curl localhost:8100/health
curl -H "x-admin-key: $AGENT_ADMIN_KEY" "localhost:8100/audit?limit=20&since=2026-01-01T00:00:00Z"
```

`limit` must be 1 to 200. Request bodies are capped at 16 KB.

### Kill switch

```
# stop: no action executes while stopped; new events are queued
curl -X POST -H "x-admin-key: $AGENT_ADMIN_KEY" localhost:8100/control/stop
# start: resumes and drains the queue
curl -X POST -H "x-admin-key: $AGENT_ADMIN_KEY" localhost:8100/control/start
```

Both return `{"stopped": true|false}`.

### Reprocess a scan

```
curl -X POST -H "x-admin-key: $AGENT_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"type":"reprocess","mediaId":"<id>"}' localhost:8100/command
```

Returns 404 if the media does not exist and 400 if it has not been analysed.

## Smoke testing

Use synthetic data only. Never point tests or smoke runs at real patient records.

## Demo

A one-click end-to-end CLI demo runner exercises all five autonomous clinical agent capabilities sequentially:

```bash
# Full dry-run (prints all synthetic requests without network calls)
npm run demo -- --dry-run

# Run against local stack
npm run demo

# Filter to a specific step
npm run demo -- --only 1
npm run demo -- --only codeblue

# Custom demo patient (must start with DEMO-)
npm run demo -- --patient DEMO-P042
```

### Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BACKEND_URL` | no | `http://localhost:5000` | MediCluster backend API URL |
| `DISPATCH_URL` | no | `http://localhost:3001` | CAD ambulance dispatch API URL |
| `AGENT_URL` | no | `http://localhost:8100` | Agent-Core HTTP API URL |
| `AGENT_ADMIN_KEY` | no | `""` | Value for `x-admin-key` header to authenticate `/audit` & `/codeblue` |
| `DEMO_STAFF_EMAIL` | live only | `""` | Clinician email for demo login (never hardcoded) |
| `DEMO_STAFF_PASSWORD` | live only | `""` | Clinician password for demo login (never hardcoded) |

### CLI Options

- `--only <step>`: Run only a single step by number (`1`..`5`) or name (`imaging`, `radar`, `ecg`, `dispatch`, `codeblue`).
- `--dry-run`: Print synthetic payloads and target endpoints without dispatching network calls.
- `--patient <id>`: Demo patient identifier (default: `DEMO-P001`). Enforces strict safety guard: **refuses to run** if the ID does not start with `DEMO-`.
- `--timeout <sec>`: Timeout per step in seconds when polling `GET /audit` (default: 90s, never hangs).

### Workflow Steps

1. **Imaging**: Generates an in-memory 256x256 grayscale chest X-ray PNG and uploads it for the demo patient via `POST /api/media/upload`.
2. **Radar/Sepsis**: Submits an 8-reading deteriorating vitals sequence (HR rising 80→150, BP falling 125/82→70/45, Temp rising 37.0→40.0°C, RR rising 16→38) via the backend readings API.
3. **ECG**: Submits a synthetic 10-second 12-lead ECG recording (12 leads × 1000 samples) via `POST /api/ecg/upload`.
4. **Dispatch**: Dispatches a synthetic SOS emergency incident via `POST /api/incidents` on the CAD dispatch API.
5. **Code Blue**: Initiates an acute ventricular fibrillation resuscitation session via `POST /codeblue/start` and formats the consensus decision card.

Each step logs timestamps, queries `GET /audit` for agent execution outcomes, and concludes with a formatted summary table.

