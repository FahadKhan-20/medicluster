import { loadConfig, signAgentToken, ConfigError } from "./config.js";
import { JevClient } from "./judge/jev.js";
import { OmniRouteProvider } from "./llm/provider.js";
import { McStore, supabaseRpc } from "./store/mc.js";
import { Audit } from "./audit/audit.js";
import { AgentState } from "./control/state.js";
import { PolicyStore } from "./control/policy.js";
import { Gate } from "./control/gate.js";
import { BackendClient } from "./tools/backend.js";
import { EventSource, realtimeSubscribe, type Event } from "./events/events.js";
import { HealthPoller } from "./events/health.js";
import { AgentLoop } from "./agent/loop.js";
import { SepsisWorkflow } from "./workflows/sepsis.js";
import { createServer } from "./api/server.js";
import { trackInFlight } from "./lifecycle.js";

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
  const jev = new JevClient({ apiKey: config.openrouterKey, model: config.jevModel });
  const llm = new OmniRouteProvider({ url: config.omnirouteUrl, apiKey: config.omnirouteKey, model: config.agentModel });
  const health = new HealthPoller({
    targets: {
      backend: `${config.backendUrl}/api/health`,
      ml: `${config.mlUrl}/health`,
      intelligence: `${config.intelUrl}/`,
    },
  });
  const loop = new AgentLoop({ jev, llm, audit, state, gate, backend, health });
  const sepsis = new SepsisWorkflow({ jev, llm, audit, state, gate, backend, health });
  const work = trackInFlight();
  const retry = work.wrap(() =>
    loop.retryPending().catch((err) => console.error("[agent-core] retryPending failed", err)),
  );
  const handle = work.wrap((e: Event) => loop.handle(e).then(() => undefined));

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
    if (e.type === "service.up") void retry();
  });
  const retryTimer = setInterval(() => void retry(), RETRY_INTERVAL_MS);
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
