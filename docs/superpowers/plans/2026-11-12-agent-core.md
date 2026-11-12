# Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agent-core`, a TypeScript service that reacts to new MediCluster imaging uploads. Jev decides what to do, Gemini executes through the existing backend APIs, and every step is audited and can be stopped.

**Architecture:** New service at `/home/vinay/medicluster/agent-core/`. It listens to Supabase Realtime on `public.medicluster_records`, builds a fact-only state with Gemini, and asks Jev for the action, urgency and act-now probability. It passes the result through a policy/autonomy gate and hard rules, then calls backend routes using a dedicated agent JWT. The backend gains an agent identity limited to an allowlist of routes, plus an agent-alerts collection.

**Tech Stack:** Node 20+, TypeScript 5, Vitest, `@supabase/supabase-js` v2 (Realtime + RPC), `yaml`, Node built-in `fetch` and `http`. The backend stays CommonJS Express with `node --test`.

**Spec:** `/home/vinay/medicluster/docs/superpowers/specs/2026-11-12-agent-core-design.md`

## Global Constraints

- Jev makes every decision. Gemini never chooses an action; a Gemini tool choice that differs from Jev's choice is rejected and audited.
- Autonomy threshold: `0.9` for both the chosen action's probability and `act_now`.
- Jev failure returns the neutral fallback (`noul` 0.5, `choice` uniform with confidence 0, `score` uniform), which must never execute.
- Jev endpoint: `POST https://openrouter.ai/api/alpha/decisions`, body `{model, state, questions}` with `meta` stripped, response `data.answers` and `data.usage.cost`. Default model `typesafe/jev-1.13`.
- Gemini: `POST ${OMNIROUTE_URL}/v1/chat/completions`, env `OMNIROUTE_URL` (default `http://localhost:20128`), `OMNIROUTE_API_KEY`, `AGENT_MODEL` (default `agy/gemini-3.8-flash-medium`).
- All MediCluster writes go through backend HTTP routes, except agent-core's own `agent_audit` and `agent_state` collections, which use the `mc_write` RPC (audit: insert and append only).
- Agent token: signed with `AGENT_JWT_SECRET` (≥ 32 chars), payload `{sub:"agent-core", kind:"agent"}`. Allowed only on: `GET /api/media/models`, `POST /api/media/analyze/:fileId`, `POST /api/media/review/:fileId`, `POST /api/alerts/agent`.
- Hard rules: no deletes; rate limit `30` actions per minute per tool group; idempotency key `<mediaId>:<analyzedAt|"new">:<action>`; treatment actions (`prescribe`, `dose`, `diagnose`) are forced to `suggest`; the kill switch overrides everything.
- Retries: Gemini 2 retries with backoff; backend 5xx up to 3 retries; backend 4xx no retry.
- Control endpoints require header `x-admin-key: ${AGENT_ADMIN_KEY}`. HTTP port `AGENT_PORT`, default `8100`.
- Never run tests or smoke checks against real patient records. Synthetic data only.
- Work on a new branch `feat/agent-core` in a git worktree. The current branch `dispatch-live-tracking-and-ui` has 19 uncommitted files that must not be touched.

## Review Focus

1. **Realtime and catch-up deliver the same row twice** (for example, a reconnect during an upload). Exactly one action is expected. Test: Task 10 `dedupes overlapping realtime and catch-up rows`.
2. **A scan with no patient record:** `/api/media/review` returns 400 "Add this result to a patient record…". Expected: marked `failed` once, with no retry loop. Test: Task 9 `review 400 is failed without retry`.
3. **A non-image upload** (`file_type: "document"`) in `patientmedias`. Expected: ignored before any Jev or Gemini call. Test: Task 11 `documents are skipped without decisions`.
4. **Gemini returns prose or broken JSON** instead of the state or arguments object. Expected: treated as a provider failure (event `pending`), never executed. Test: Task 6 `non-JSON reply is a provider failure`.
5. **The agent's own analysis write re-fires `scan.analyzed`, or a clinician re-analyzes the same scan.** Expected: round 2 runs once per `analyzedAt`, and an alert is never created twice for the same analysis. Test: Task 11 `re-analysis with same analyzedAt creates no second alert`.

---

## File Structure

```
medicluster/backend/
  middleware/auth.js                       MODIFY  agent token sign/verify + allowlist in requireAuth
  models/AgentAlert.js                     CREATE  collection agentalerts
  routes/alertRoutes.js                    MODIFY  POST /agent + merge into GET /
  supabase/migrations/20261112_agent_realtime.sql  CREATE
  tests/agentAccess.test.js                CREATE
  tests/agentAlerts.test.js                CREATE
  tests/agentRealtimeSql.test.js           CREATE
medicluster/docker-compose.yml             MODIFY  agent-core service + AGENT_JWT_SECRET on backend

agent-core/
  package.json, tsconfig.json, vitest.config.ts, Dockerfile, policy.yaml, .env.example, README.md
  src/config.ts            env parsing
  src/judge/jev.ts         Jev client + question builders + fallback + FakeJev
  src/llm/provider.ts      LlmProvider interface + OmniRoute implementation + FakeLlm
  src/store/mc.ts          RPC client for mc_find / mc_write
  src/audit/audit.ts       audit writer
  src/control/state.ts     agent_state: stopped flag, cursor, queue, done keys
  src/control/policy.ts    policy.yaml loader with last-valid fallback
  src/control/gate.ts      autonomy gate + hard rules + rate limiter
  src/tools/backend.ts     backend HTTP client (agent token, retry rules)
  src/tools/registry.ts    tool definitions: imaging.*, alerts.create
  src/events/events.ts     row -> event mapping, realtime listener, catch-up, dedupe
  src/events/health.ts     health poller
  src/agent/loop.ts        main loop + imaging workflow
  src/api/server.ts        HTTP API
  src/main.ts              wiring
  tests/*.test.ts
```

---

### Task 1: Backend agent identity and route allowlist

**Files:**
- Modify: `medicluster/backend/middleware/auth.js`
- Test: `medicluster/backend/tests/agentAccess.test.js`

**Interfaces:**
- Produces: `signAgentToken(): string` (exported); `AGENT_ROUTES: Array<{method: string, pattern: RegExp}>` (exported). `requireAuth` sets `req.userId = "agent-core"` and `req.agent = true` for agent sessions.

- [ ] **Step 1: Write failing tests** in `tests/agentAccess.test.js` (style of `staffAccess.test.js`: express app on an ephemeral port, env saved and restored in `t.after`). Mount `requireAuth` on `GET /api/media/models`, `POST /api/media/analyze/:id`, `POST /api/media/review/:id`, `POST /api/alerts/agent`, `GET /api/alerts`, `GET /api/data/x`, each returning `{ok:true, userId:req.userId}`. Tests:
  - `agent token reaches allowlisted routes`: the 4 allowlisted routes return 200 with `userId === "agent-core"`.
  - `agent token is 403 elsewhere`: `GET /api/alerts` and `GET /api/data/x` return 403 `{error:"Agent access not permitted for this route"}`.
  - `agent token signed with JWT_SECRET is rejected`: `jwt.sign({sub:"agent-core",kind:"agent"}, JWT_SECRET)` returns 401.
  - `missing AGENT_JWT_SECRET disables agent tokens`: unset it, then any agent token returns 401, and clinician tokens still return 200.
  - `signAgentToken throws when AGENT_JWT_SECRET is shorter than 32 chars`.

- [ ] **Step 2: Run** `cd medicluster/backend && node --test tests/agentAccess.test.js`. Expected: FAIL (`signAgentToken is not a function`).

- [ ] **Step 3: Implement in `auth.js`.** `signAgentToken()` signs `{sub:"agent-core", kind:"agent"}` with `AGENT_JWT_SECRET`, 12h TTL. In `readSession`, when JWT_SECRET verification fails, try `AGENT_JWT_SECRET` (only if set and ≥ 32 chars) and accept only payloads with `kind === "agent"`, returning `{kind:"agent"}`. In `requireAuth`, for agent sessions, match `req.method` and `req.baseUrl + req.path` against `AGENT_ROUTES` (regexes anchored on the full path, `:fileId` as `[a-zA-Z0-9_-]{1,128}`). Return 403 with the message above if there is no match. `requirePatientOrClinician` rejects agent sessions with 403.

- [ ] **Step 4: Run** the new test file and then the full `npm test`. Expected: all pass (the existing 230 included).

- [ ] **Step 5: Commit** `feat(backend): add agent service identity with route allowlist`.

---

### Task 2: Agent alerts endpoint and merge

**Files:**
- Create: `medicluster/backend/models/AgentAlert.js`
- Modify: `medicluster/backend/routes/alertRoutes.js`
- Test: `medicluster/backend/tests/agentAlerts.test.js`

**Interfaces:**
- Consumes: Task 1 `signAgentToken`.
- Produces: `POST /api/alerts/agent` with body `{patient_id, source_id, severity: "WARNING"|"HIGH"|"CRITICAL", title, summary, jev_probabilities: object, audit_id}`. It responds 201 with the stored alert, or 200 with the existing alert when `source_id + audit_id` already exists. `GET /api/alerts` items for agent alerts: `{id:"agent:<_id>", at, severity, source:"agent", patientId, title, body: summary, facts:[["Decided by","Jev"],["Confidence","<pct>%"]], link:"/patient/<id>", read}`.

- [ ] **Step 1: Write failing tests** (use `createTestDatabase(t)` from `helpers/supabaseTestDb`, and mount the router with `requireAuth` the way `server.js` does):
  - `agent creates alert`: 201, and the stored fields match the request.
  - `duplicate source_id+audit_id returns existing`: the second POST returns 200 with the same `_id`, and the count stays 1.
  - `validation`: missing `patient_id` gives 400; severity `"LOW"` gives 400; title over 200 chars gives 400; `jev_probabilities` over 4000 JSON chars gives 400.
  - `clinician token cannot POST /agent`: 403 `{error:"Agent sign-in required"}`.
  - `GET merges agent alerts`: after an agent POST, a clinician GET includes an item with `source:"agent"` and `id` starting `agent:`, sorted by `at` with the others.

- [ ] **Step 2: Run** `node --test tests/agentAlerts.test.js`. Expected: FAIL (404 on POST).

- [ ] **Step 3: Implement.** `AgentAlert` is defined with `defineModel("AgentAlert", ...)` (collection `agentalerts`, `timestamps: true`). In `alertRoutes.js`, add `router.post("/agent")` (it rejects `!req.agent` with 403) and an `agentAlerts()` group added to the `Promise.all` in `GET /`. Confidence pct = `Math.round(100 * max(Object.values(jev_probabilities.action ?? {})))`.

- [ ] **Step 4: Run** the new test file and the full `npm test`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(backend): add agent alerts endpoint and merge into alert feed`.

---

### Task 3: Realtime migration

**Files:**
- Create: `medicluster/backend/supabase/migrations/20261112_agent_realtime.sql`
- Test: `medicluster/backend/tests/agentRealtimeSql.test.js`

- [ ] **Step 1: Write the failing test.** It reads the SQL file and asserts it contains, case-insensitive: `ALTER PUBLICATION supabase_realtime ADD TABLE public.medicluster_records`, `GRANT SELECT ON public.medicluster_records TO service_role`. It also asserts it does **not** match `/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i`.
- [ ] **Step 2: Run.** Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration.** Wrap the publication add in a `DO` block that skips when the table is already in `pg_publication_tables`, so it is idempotent.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): enable realtime read access for agent core`.

---

### Task 4: agent-core scaffold and config

**Files:**
- Create: `agent-core/package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `type Config = { supabaseUrl, supabaseKey, backendUrl, agentJwt: string, adminKey, omnirouteUrl, omnirouteKey, agentModel, openrouterKey, jevModel, port: number, policyPath: string }`; `loadConfig(env: Record<string,string|undefined>): Config` throws `ConfigError` listing every missing required key.

- [ ] **Step 1: Write failing tests:** defaults (`agentModel === "agy/gemini-3.8-flash-medium"`, `jevModel === "typesafe/jev-1.13"`, `port === 8100`, `omnirouteUrl === "http://localhost:20128"`, `policyPath === "policy.yaml"`). Missing `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `BACKEND_URL`, `AGENT_JWT_SECRET`, `AGENT_ADMIN_KEY` and `OPENROUTER_API_KEY` are all reported in one error. An `AGENT_JWT_SECRET` shorter than 32 characters fails. `agentJwt` is a token produced from `AGENT_JWT_SECRET` (use `jsonwebtoken`, same payload as Task 1).
- [ ] **Step 2: Run** `cd agent-core && npm install && npx vitest run tests/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `package.json` scripts: `build: tsc`, `test: vitest run`, `start: node dist/main.js`. Dependencies: `@supabase/supabase-js@^2`, `yaml@^2`, `jsonwebtoken@^9`. Dev dependencies: `typescript@^5`, `vitest@^2`, `@types/node`, `@types/jsonwebtoken`. ESM (`"type":"module"`), `tsconfig` target ES2022, module NodeNext, strict.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): scaffold service and config`.

---

### Task 5: Jev client port

**Files:**
- Create: `agent-core/src/judge/jev.ts`, `tests/jev.test.ts`

**Interfaces:**
- Produces:
  - `type Question = {type:"noul"|"choice"|"score", instructions:string, criteria?: Record<string,string>|string[], meta?: object}`
  - `noul(instructions, meta?)`, `choice(instructions, criteria, meta?)`, `score(instructions, levels, meta?)`, each returning `Question`
  - `type Answer = {type, noul?:number, choice?:string, score?:number, probabilities?:Record<string,number>, confidence?:number}`
  - `interface Decider { decide(state: unknown, questions: Record<string,Question>, purpose?: string): Promise<{answers: Record<string,Answer>, cost: number, fallback: boolean, error?: string}> }`
  - `class JevClient implements Decider` (constructor `{apiKey, model, baseUrl="https://openrouter.ai/api", fetch=globalThis.fetch, retries=2, backoffMs=500}`)
  - `fallbackAnswer(q: Question): Answer`; `class FakeJev implements Decider` (constructor takes `rules(name, q) => Answer` and records `calls`)

- [ ] **Step 1: Write failing tests** (fake `fetch`):
  - `posts to /alpha/decisions with meta stripped`: URL `https://openrouter.ai/api/alpha/decisions`, `Authorization: Bearer <key>`, body `{model, state, questions}`, and no `meta` key in the questions.
  - `returns answers and cost`: response `{answers:{a:{type:"noul",noul:0.97}}, usage:{cost:0.0012}}` gives `cost === 0.0012` and `fallback === false`.
  - `fallback shapes match cse/jev.py`: noul gives `0.5`; choice over `{x,y}` gives `choice "x"`, probabilities `{x:0.5,y:0.5}`, confidence 0; score over 3 levels gives `score 1`, probabilities `{"0":1/3,"1":1/3,"2":1/3}`, confidence 0.
  - `401 falls back without retry`: fetch is called once, `fallback === true`.
  - `500 retries twice then falls back`: fetch is called 3 times.
  - `network error never throws`: `decide` resolves with `fallback: true` and a non-empty `error`.
- [ ] **Step 2: Run** `npx vitest run tests/jev.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** following `context-selection-engine/cse/jev.py` `JevClient.decide`. Retry on 5xx, 429 and network errors; break on other 4xx. No key rotation (single key).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): port Jev decision client`.

---

### Task 6: LLM provider (OmniRoute/Gemini)

**Files:**
- Create: `agent-core/src/llm/provider.ts`, `tests/provider.test.ts`

**Interfaces:**
- Produces: `interface LlmProvider { json<T>(system: string, user: string): Promise<T> }`, which throws `ProviderError` on failure. `class OmniRouteProvider implements LlmProvider` (constructor `{url, apiKey, model, fetch?, retries=2, backoffMs=500, timeoutMs=30000}`). `class FakeLlm implements LlmProvider` (constructor takes `(system, user) => unknown`).

- [ ] **Step 1: Write failing tests:**
  - `posts chat completion`: URL `${url}/v1/chat/completions`, body has `model`, `temperature: 0.2`, `response_format: {type:"json_object"}`, and messages `[system, user]`.
  - `parses JSON content`: `choices[0].message.content` of `'{"a":1}'` gives `{a:1}`.
  - `strips json code fence`: a content of "```json\n{\"a\":1}\n```" gives `{a:1}`.
  - `non-JSON reply is a provider failure`: content `"Sure, here it is"` throws `ProviderError`.
  - `retries twice on 5xx/timeout then throws ProviderError`: fetch is called 3 times.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** On a 400 or 422 response, retry once without `response_format`, the same fallback CliniQ uses.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): add OmniRoute Gemini provider`.

---

### Task 7: Store, audit and agent state

**Files:**
- Create: `agent-core/src/store/mc.ts`, `src/audit/audit.ts`, `src/control/state.ts`, `tests/store.test.ts`

**Interfaces:**
- Produces:
  - `interface Rpc { (name: string, args: object): Promise<unknown> }`; `supabaseRpc(url, key, fetch?) => Rpc` (POST `/rest/v1/rpc/<name>`, same headers as `backend/db/supabase.js`: `apikey`, plus `Authorization: Bearer` unless the key starts with `sb_secret_`)
  - `class McStore` (constructor takes an `Rpc`): `find(collection, filter, sort?, limit?): Promise<any[]>`, `insert(collection, doc): Promise<any>`, `update(collection, filter, update): Promise<any>`, `upsert(collection, filter, update): Promise<any>`. There is **no** delete method.
  - `class Audit` (constructor takes a `McStore`): `start(event): Promise<string /*auditId*/>`, `append(auditId, step: {kind: string, data: object}): Promise<void>` (uses `$push` on `steps`), `finish(auditId, outcome: "executed"|"review"|"skipped"|"pending"|"failed"|"blocked", reason?: string)`, `list(since?: string, limit=50): Promise<any[]>`. Collection `agent_audit`.
  - `class AgentState` (constructor takes a `McStore`), stored in collection `agent_state` as doc `_id:"agent-core"`: `isStopped()`, `setStopped(b)`, `cursor(): Promise<string|null>`, `setCursor(iso)`, `enqueue(event)`, `drain(): Promise<Event[]>`, `isDone(key)`, `markDone(key)`.
- [ ] **Step 1: Write failing tests** with a fake in-memory `Rpc` that interprets `mc_find`/`mc_write` for `$set`, `$push` and equality filters:
  - `audit is append-only`: `Audit` has no edit or delete API, and `append` sends `p_action:"update"` with only `$push.steps`.
  - `McStore has no delete`: `"delete" in store === false`.
  - `stopped flag persists`: `setStopped(true)` on one `AgentState` instance is seen by a new instance over the same `Rpc`.
  - `queue drains once`: enqueue 2, drain gives 2, drain again gives 0.
  - `done keys`: `markDone("k")` then `isDone("k") === true`.
  - `rpc headers`: an `sb_secret_x` key sends `apikey` without `authorization`; a JWT-shaped key sends both.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `mc_write` args follow the SQL signature (`p_collection, p_action, p_filter, p_update, p_document, p_upsert, p_return_new`). New `_id`s use `crypto.randomUUID()`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): add record store, audit log and agent state`.

---

### Task 8: Policy, gate and hard rules

**Files:**
- Create: `agent-core/src/control/policy.ts`, `src/control/gate.ts`, `agent-core/policy.yaml`, `tests/gate.test.ts`

**Interfaces:**
- Produces:
  - `type Level = "off"|"suggest"|"auto"`; `type Policy = {threshold: number, groups: Record<string, Level>, rateLimitPerMinute: number}`
  - `class PolicyStore` (constructor `(path, log)`): `current(): Policy`, `reload(): void`. An invalid file keeps the last valid policy and logs. With no valid policy ever loaded, it defaults to `{threshold:0.9, groups:{}, rateLimitPerMinute:30}`.
  - `type GateInput = {group: string, action: string, actionProb: number, actNow: number, fallback: boolean, stopped: boolean, key: string, done: boolean}`
  - `type GateResult = {verdict: "execute"|"review"|"blocked", reason: string}`
  - `class Gate` (constructor `(policy: PolicyStore, now = () => Date.now())`): `check(input): GateResult`, `record(group)` (counts toward the rate limit)
  - `const TREATMENT_ACTIONS = ["prescribe","dose","diagnose"]`
- [ ] **Step 1: Write failing tests**, one per rule. Order of evaluation: stopped > done > delete > off > rate > treatment > fallback > suggest > thresholds.
  - `stopped blocks`: `{verdict:"blocked", reason:"stopped"}`.
  - `done key blocks`: reason `"duplicate"`.
  - `action containing "delete" blocks`: reason `"no_delete"`.
  - `off group blocks`: reason `"group_off"`; an absent group is treated as off.
  - `rate limit`: after 30 `record("imaging")` within 60s, `check` gives blocked `"rate_limited"`; at 61s it is allowed again.
  - `treatment forced to review`: action `"prescribe"` with probability 0.99 gives `review`, reason `"treatment_requires_doctor"`.
  - `fallback never executes`: `fallback:true` with probabilities of 0.99 gives `review`, reason `"jev_fallback"`.
  - `suggest level`: gives `review`, reason `"suggest_level"`.
  - `threshold`: `actionProb 0.9, actNow 0.9` gives `execute`; `0.89` on either gives `review`, reason `"low_confidence"`.
  - `invalid policy keeps last valid`: write valid YAML, reload, write `"groups: ["`, reload, and `current()` is unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `policy.yaml` content follows spec §4.1 (`threshold: 0.9`, `imaging: auto`, `alerts: auto`, `rate_limit_per_minute: 30`). Watch the file with `fs.watch` and call `reload()`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): add policy, autonomy gate and hard rules`.

---

### Task 9: Backend client and tools

**Files:**
- Create: `agent-core/src/tools/backend.ts`, `src/tools/registry.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `Config.agentJwt`, `Config.backendUrl`.
- Produces:
  - `class BackendClient` (constructor `{baseUrl, token, fetch?, retries=3, backoffMs=500}`): `call(method, path, body?): Promise<{ok:true, status, data} | {ok:false, status, error, retryable:false}>`. Retries on 5xx and network errors, never on 4xx.
  - `type Tool = {name: string, group: "imaging"|"alerts", action: "analyze"|"request_review"|"alert", schema: object, run(args, client): Promise<ToolResult>}`
  - `TOOLS: Tool[]` with `imaging.analyze` (`{fileId, model_name?}` → `POST /api/media/analyze/:fileId`), `imaging.request_review` (`{fileId}` → `POST /api/media/review/:fileId`), `alerts.create` (Task 2 body → `POST /api/alerts/agent`). The non-action helper `listModels(client)` calls `GET /api/media/models`.
  - `toolForAction(action): Tool | undefined`; `validateArgs(tool, args): string[]` (error list; `fileId` must match `^[a-zA-Z0-9_-]{1,128}$`, no extra keys).
- [ ] **Step 1: Write failing tests:**
  - `sends agent bearer token`.
  - `5xx retried 3 times then ok:false`: fetch is called 4 times.
  - `review 400 is failed without retry`: fetch is called once, and the result is `{ok:false, status:400}`.
  - `path ids are encoded and validated`: `fileId "../x"` gives a validation error and no fetch.
  - `extra args rejected`.
  - `toolForAction("ignore") === undefined`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): add backend client and imaging/alert tools`.

---

### Task 10: Events, catch-up and health

**Files:**
- Create: `agent-core/src/events/events.ts`, `src/events/health.ts`, `tests/events.test.ts`

**Interfaces:**
- Produces:
  - `type Event = {id: string, type: "scan.uploaded"|"scan.analyzed"|"service.down"|"service.up", mediaId?: string, analyzedAt?: string, doc?: any, service?: string, at: string}`. `id` = `<mediaId>:<analyzedAt|"new">`, or `<service>:<state>:<at>`.
  - `rowToEvent(row: {collection: string, data: any}, old?: any): Event | null`. A `patientmedias` insert becomes `scan.uploaded`. An update where `analysis.analyzedAt` changed becomes `scan.analyzed`. Everything else returns null.
  - `class EventSource` (constructor `{store: McStore, state: AgentState, subscribe: (onRow) => () => void}`): `start(onEvent)`, `stop()`. On start and on every reconnect it runs `catchUp()` (`store.find("patientmedias", {updatedAt: {$gt: cursor}}, {updatedAt: 1}, 200)`). It dedupes by `Event.id` within a 10-minute window, and advances the cursor after `onEvent` resolves.
  - `realtimeSubscribe(supabaseUrl, key) => subscribe`, wrapping `supabase.channel("agent-core").on("postgres_changes", {event:"*", schema:"public", table:"medicluster_records", filter:"collection=eq.patientmedias"}, …)`, and calling `onReconnect` on `SUBSCRIBED` after `CHANNEL_ERROR`/`TIMED_OUT`.
  - `class HealthPoller` (constructor `{targets: Record<string,string>, intervalMs=15000, fetch?}`): `start(onEvent)`, `isUp(name): boolean`. It emits only on state change. Targets: `backend: ${BACKEND_URL}/api/health`, `ml: ML_URL/health`, `intelligence: INTEL_URL/` (a 401 counts as up).
- [ ] **Step 1: Write failing tests:**
  - `insert maps to scan.uploaded`; `analysis change maps to scan.analyzed`; `other collection is null`; `update without analyzedAt change is null`.
  - `dedupes overlapping realtime and catch-up rows`: the same row through the subscription and through catch-up gives `onEvent` once.
  - `cursor advances only after handler resolves`: a handler that rejects leaves the cursor unchanged.
  - `reconnect runs catch-up`.
  - `health emits on change only`, and `401 counts as up`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-core): add realtime events, catch-up and health poller`.

---

### Task 11: Agent loop and imaging workflow

**Files:**
- Create: `agent-core/src/agent/loop.ts`, `tests/loop.test.ts`

**Interfaces:**
- Consumes: `Decider` (Task 5), `LlmProvider` (Task 6), `Audit`, `AgentState` (Task 7), `Gate`, `TREATMENT_ACTIONS` (Task 8), `BackendClient`, `toolForAction`, `validateArgs` (Task 9), `Event`, `HealthPoller.isUp` (Task 10).
- Produces: `class AgentLoop` (constructor `{jev, llm, audit, state, gate, backend, health}`): `handle(event): Promise<"executed"|"review"|"skipped"|"pending"|"failed"|"blocked">`. `JEV_QUESTIONS`: an object with `action` (choice over `analyze`, `alert`, `request_review`, `ignore`, each with a one-line criterion), `urgency` (score `["routine","urgent","critical"]`), and `act_now` (noul "Acting now on the chosen action is safe and correct for this patient").

**Flow in `handle`:**
1. A `scan.*` event whose doc has `file_type !== "image"` gives `skipped` (no Jev or LLM call).
2. If `state.isStopped()`: `state.enqueue(event)`, giving `blocked`.
3. If the event is `scan.uploaded` and `health.isUp("backend")` is false, or the ML worker is down: `pending`, audit reason `"analysis_unavailable"`.
4. `llm.json(STATE_PROMPT, JSON.stringify(doc))` gives the state object `{patientId, modality, fileName, findings, model}`. A `ProviderError` gives `pending`.
5. `jev.decide(state, JEV_QUESTIONS, "imaging")` gives the answers. The chosen action is `answers.action.choice`; the action probability is `answers.action.probabilities[choice]`; actNow is `answers.act_now.noul`.
6. `ignore` gives `skipped`.
7. `gate.check({...})` with key `<event.id>:<action>`. `blocked` gives `blocked`. `review` calls `imaging.request_review` (if not already done) and gives `review`.
8. `execute`: `llm.json(ARGS_PROMPT, {action, tool schema, state, urgency})` returns `{tool, arguments}`. If `tool !== toolForAction(action).name`, the result is `failed` with reason `"llm_tool_mismatch"`. Otherwise `validateArgs`, run, then `gate.record(group)` and `state.markDone(key)`.
9. For `alert`, the arguments must include `severity` mapped from urgency (`routine`→`WARNING`, `urgent`→`HIGH`, `critical`→`CRITICAL`, enforced by code, not by the LLM), plus `jev_probabilities` and `audit_id`.
10. Every step is appended to the audit, and `finish` records the outcome.
11. Every `pending` outcome calls `state.enqueue(event)`. `AgentLoop.retryPending(): Promise<number>` drains the queue and re-handles each event, returning how many it handled. Task 12 calls it on every `service.up` event, on a 60-second timer, and after `/control/start`.

- [ ] **Step 1: Write failing tests** with `FakeJev`, `FakeLlm`, the in-memory `Rpc` from Task 7 and a fake `BackendClient`:
  - `critical at 0.95 creates alert`: on `scan.analyzed`, the outcome is `executed`, one `POST /api/alerts/agent` is made with `severity:"CRITICAL"`, and the audit steps include `state`, `jev`, `gate`, `tool`.
  - `0.6 confidence requests review`: the outcome is `review`, `POST /api/media/review/:id` is called, and no alert is created.
  - `upload with analyze executes analysis`: `scan.uploaded` with action `analyze` at 0.95 calls `POST /api/media/analyze/:id`.
  - `jev fallback never executes`: the outcome is `review`.
  - `llm tool mismatch is rejected`: Jev says `alert`, the LLM returns `tool:"imaging.analyze"`, so the outcome is `failed` and no backend call is made.
  - `gemini down leaves event pending`: `FakeLlm` throws `ProviderError`, so the outcome is `pending` with no Jev call.
  - `stopped queues event`: the outcome is `blocked` and `drain()` returns the event.
  - `documents are skipped without decisions`: `FakeJev.calls.length === 0`.
  - `re-analysis with same analyzedAt creates no second alert`: `handle` called twice on the same event gives the second outcome `blocked` (duplicate), and 1 alert POST in total.
  - `ml worker down marks analysis_unavailable`, and the event is enqueued.
  - `retryPending reprocesses after recovery`: Gemini first throws and then succeeds. After `retryPending()`, the outcome is `executed` and the queue is empty.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `STATE_PROMPT` and `ARGS_PROMPT` are constants in `loop.ts`. Both say: return JSON only, facts only, never choose or change the action.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(agent-core): add agent loop with Jev-decided imaging workflow`.

---

### Task 12: HTTP API, wiring, Docker

**Files:**
- Create: `agent-core/src/api/server.ts`, `src/main.ts`, `agent-core/Dockerfile`, `agent-core/README.md`, `tests/api.test.ts`
- Modify: `medicluster/docker-compose.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: `createServer({audit, state, loop, health, adminKey}): http.Server` with these routes:
  - `GET /health`: `{status:"ok", stopped, services:{backend, ml, intelligence}}`
  - `GET /audit?since=&limit=`: admin key required; `limit` must be 1 to 200 (400 otherwise)
  - `POST /control/stop` and `POST /control/start`: admin key required; `start` drains the queue through `loop.handle`; both return `{stopped}`
  - `POST /command`: admin key required; v1 accepts `{type:"reprocess", mediaId}` and runs `loop.handle` on a synthetic `scan.analyzed` built from `store.find("patientmedias", {_id: mediaId})`; anything else gives 400 `{error:"Unsupported command"}`
  - A missing or wrong admin key gives 401.

- [ ] **Step 1: Write failing tests:** `health is public`; `audit requires admin key`; `stop then start drains queue` (a queued event is handled once); `bad limit 400`; `unsupported command 400`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `main.ts`: `loadConfig(process.env)`, build all components, start the `HealthPoller`, start the `EventSource` with `loop.handle`, and listen on `config.port`. Handle SIGTERM: stop the event source, let the in-flight handler finish, then close the server. The Dockerfile uses `node:20-alpine` with a multi-stage `npm ci && npm run build` and `CMD ["node","dist/main.js"]`. In compose, add the `agent-core` service (build `../agent-core`, `restart: unless-stopped`, env from Global Constraints, `BACKEND_URL: http://backend:5000`, port `8100:8100`, `depends_on: backend`), and add `AGENT_JWT_SECRET: ${AGENT_JWT_SECRET:?Set AGENT_JWT_SECRET}` to the backend service. The README covers env vars, run, the kill switch with curl examples, and the synthetic-data-only smoke rule.
- [ ] **Step 4: Run** `npx vitest run && npm run build`, then `docker compose -f medicluster/docker-compose.yml config -q`. Expected: tests pass, build succeeds, compose is valid.
- [ ] **Step 5: Commit** `feat(agent-core): add HTTP API, wiring and Docker Compose service`.

---

### Task 13: Live smoke check (manual, synthetic data)

- [ ] **Step 1:** Apply the Task 3 migration to the Supabase project. **Ask the user before running it.** It changes production database grants.
- [ ] **Step 2:** `docker compose up --build backend ml-engine agent-core` with real `OMNIROUTE_*` and `OPENROUTER_API_KEY`.
- [ ] **Step 3:** As a clinician, create a demo patient named `SMOKE-AGENT-<date>`, upload a public synthetic chest X-ray, and attach it to that patient.
- [ ] **Step 4:** Run `curl -H "x-admin-key: $AGENT_ADMIN_KEY" localhost:8100/audit?limit=5`. Expected: an entry with `scan.uploaded`, then `analyze` executed, then `scan.analyzed`, then an `alert` or `review` decision, with Jev probabilities present.
- [ ] **Step 5:** `POST /control/stop`, upload a second scan, and confirm the audit shows `blocked` with no backend action. `POST /control/start` and confirm it is processed.
- [ ] **Step 6:** Delete the smoke patient through the normal clinician UI. Record the results in the PR description.
