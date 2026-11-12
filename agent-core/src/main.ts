import { loadConfig, signAgentToken, ConfigError } from "./config.js";
import { JevClient } from "./judge/jev.js";
import { OmniRouteProvider } from "./llm/provider.js";
import { McStore, supabaseRpc } from "./store/mc.js";
import { Audit } from "./audit/audit.js";
import { AgentState } from "./control/state.js";
import { PolicyStore } from "./control/policy.js";
import { Gate } from "./control/gate.js";
import { BackendClient } from "./tools/backend.js";
import { DispatchClient } from "./tools/dispatch.js";
import { EventSource, realtimeSubscribe, type Event } from "./events/events.js";
import { HealthPoller } from "./events/health.js";
import { AgentLoop } from "./agent/loop.js";
import { registerRemindersWorkflow } from "./workflows/reminders.js";
import { registerSelfheal } from "./selfheal/index.js";
import { createDispatchWorkflow } from "./workflows/dispatch.js";
import { createServer } from "./api/server.js";
import { trackInFlight } from "./lifecycle.js";
import { registerRadarWorkflow } from "./workflows/radar.js";

const RETRY_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = (msg: string) => console.log(`[agent-core] ${msg}`);

  const store = new McStore(supabaseRpc(config.supabaseUrl, config.supabaseKey));
  const audit = new Audit(store);
  const state = new AgentState(store);
  const policyStore = new PolicyStore(config.policyPath, log);
  const gate = new Gate(policyStore);
  const backend = new BackendClient({
    baseUrl: config.backendUrl,
    token: () => signAgentToken(config.agentJwtSecret),
  });
  const dispatchUrl = process.env.DISPATCH_URL || "http://dispatch-api:3001";
  const dispatchClient = new DispatchClient({
    baseUrl: dispatchUrl,
    token: () => signAgentToken(config.agentJwtSecret),
  });
  const jev = new JevClient({ apiKey: config.openrouterKey, model: config.jevModel });
  const llm = new OmniRouteProvider({ url: config.omnirouteUrl, apiKey: config.omnirouteKey, model: config.agentModel });
  const health = new HealthPoller({
    targets: {
      backend: `${config.backendUrl}/api/health`,
      ml: `${config.mlUrl}/health`,
      intelligence: `${config.intelUrl}/`,
      dispatch: `${dispatchUrl}/health`,
    },
  });
  const loop = new AgentLoop({ jev, llm, audit, state, gate, backend, health, store });
  const reminders = registerRemindersWorkflow({ jev, llm, audit, state, gate, backend, store, health });
  const loop = new AgentLoop({ jev, llm, audit, state, gate, backend, health });
  const dispatchWorkflow = createDispatchWorkflow({
    jev,
    llm,
    audit,
    state,
    gate,
    health,
    dispatchClient,
  });
  const work = trackInFlight();
  const radar = registerRadarWorkflow({ jev, llm, audit, state, gate, backend, health, subscribe: realtimeSubscribe(config.supabaseUrl, config.supabaseKey), work });
  const selfheal = registerSelfheal(health, { jev, llm, audit, state, gate, backend, work });
  const retry = work.wrap(() =>
    Promise.all([
      loop.retryPending().catch((err) => console.error("[agent-core] loop retryPending failed", err)),
      selfheal.retryPending().catch((err) => console.error("[agent-core] selfheal retryPending failed", err)),
      loop.retryPending().catch((err) => console.error("[agent-core] retryPending loop failed", err)),
      dispatchWorkflow.retryPending().catch((err) => console.error("[agent-core] retryPending dispatch failed", err)),
    ]),
  );
  const handle = work.wrap((e: Event) => loop.handle(e).then(() => undefined));

  // Poll dispatch API every 10s for new PENDING incidents to feed dispatchWorkflow
  const pollDispatch = work.wrap(async () => {
    if (health.isUp("dispatch") === false) return;
    try {
      const res = await dispatchClient.getPendingIncidents();
      if (res.ok && Array.isArray(res.data)) {
        for (const inc of res.data) {
          if (inc && inc.id && inc.status === "PENDING" && !inc.assigned_ambulance_id) {
            await dispatchWorkflow.handle({
              id: inc.id,
              type: "incident.pending",
              incidentId: inc.id,
              doc: inc,
              at: typeof inc.created_at === "string" ? inc.created_at : new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.error("[agent-core] dispatch poll failed", err);
    }
  });

  const events = new EventSource({
    store,
    state,
    subscribe: realtimeSubscribe(config.supabaseUrl, config.supabaseKey),
  });

  const server = createServer({ audit, state, loop, health, store, adminKey: config.adminKey });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log(`listening on ${config.port}`);

  policyStore.watch();
  await health.start((e: Event) => {
    if (e.type === "service.up") {
      void retry();
      void pollDispatch();
    }
  });
  const retryTimer = setInterval(() => void retry(), RETRY_INTERVAL_MS);
  const dispatchPollTimer = setInterval(() => void pollDispatch(), 10_000);
  await events.start(handle);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(0), 10_000).unref();
    events.stop();
    health.stop();
    clearInterval(retryTimer);
    clearInterval(dispatchPollTimer);
    policyStore.close();
    await work.drain();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
