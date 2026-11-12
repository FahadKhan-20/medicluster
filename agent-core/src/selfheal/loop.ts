import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, score, type Decider, type DecideResult } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { toolForAction, validateArgs, type Tool } from "../tools/registry.js";
import type { DockerClient, ContainerInspect } from "./docker.js";
import { RestartTracker } from "./tracker.js";

export type Outcome = AuditOutcome;

export const DEFAULT_CONTAINERS: Record<string, string> = {
  backend: "medicluster-backend-1",
  ml: "medicluster-ml-engine-1",
};

export function resolveContainers(
  custom?: Record<string, string>,
  envVal = process.env.SELFHEAL_CONTAINERS,
): Record<string, string> {
  let envContainers: Record<string, string> = {};
  if (envVal) {
    try {
      const parsed = JSON.parse(envVal);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        envContainers = parsed;
      }
    } catch {
      // Ignore malformed JSON in env
    }
  }
  return { ...DEFAULT_CONTAINERS, ...envContainers, ...(custom ?? {}) };
}

export const SELFHEAL_QUESTIONS = {
  action: choice("Which self-heal action should the agent take for this failing service or container?", {
    restart: "Restart the container for the failing service to restore availability.",
    wait: "The service is temporarily recovering, starting up, or should not be restarted yet.",
    escalate: "Automatic restart has exceeded limits, failed, or the issue requires human operator intervention.",
  }),
  urgency: score("How urgent is this service failure?", ["routine", "urgent", "critical"]),
  act_now: noul("Acting now on the chosen self-heal action is safe and necessary to restore service availability"),
};

export const SELFHEAL_ALERT_PROMPT = [
  "You fill the title and summary arguments of an alert tool whose escalation has already been decided.",
  "Return JSON only: {\"title\": \"...\", \"summary\": \"...\"}.",
  "Facts only strictly from the given state; max 200 characters for title, max 2000 for summary.",
  "Never choose or change the action.",
].join("\n");

export interface SelfhealDeps {
  docker: DockerClient;
  jev: Decider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  llm?: LlmProvider;
  containers?: Record<string, string>;
  tracker?: RestartTracker;
  now?: () => number;
}

type Ctx = { event: Event; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string };

export class SelfhealLoop {
  private readonly d: SelfhealDeps;
  private readonly containers: Record<string, string>;
  private readonly tracker: RestartTracker;
  private readonly inFlight = new Set<string>();
  private retrying?: Promise<number>;

  constructor(deps: SelfhealDeps) {
    this.d = deps;
    this.containers = resolveContainers(deps.containers);
    this.tracker = deps.tracker ?? new RestartTracker({ now: deps.now });
  }

  isSelfhealEvent(event: Event): boolean {
    return (
      event.type === "service.down" ||
      (event.type as string) === "container.exited" ||
      (event.type as string) === "container.unhealthy"
    );
  }

  async handle(event: Event): Promise<Outcome> {
    return (await this.process(event)).outcome;
  }

  async checkContainer(service: string): Promise<Outcome> {
    const container = this.containers[service];
    if (!container) return "failed";
    const inspect = await this.d.docker.inspect(container);
    if (!inspect) return "failed";
    if (
      inspect.status === "exited" ||
      inspect.health === "unhealthy" ||
      (!inspect.running && inspect.status !== "created")
    ) {
      const at = new Date().toISOString();
      const event: Event = {
        id: `${service}:container:${inspect.status}:${at}`,
        type: "service.down",
        service,
        at,
        doc: inspect,
      };
      return this.handle(event);
    }
    return "skipped";
  }

  retryPending(): Promise<number> {
    this.retrying ??= this.drainQueue().finally(() => {
      this.retrying = undefined;
    });
    return this.retrying;
  }

  private async drainQueue(): Promise<number> {
    if (await this.d.state.isStopped()) return 0;
    const events = await this.d.state.drain();
    let handled = 0;
    for (const e of events) {
      const ev = e as Event;
      if (this.isSelfhealEvent(ev)) {
        const { keep } = await this.process(ev);
        if (!keep) await this.d.state.ack(ev.id);
        handled++;
      }
    }
    return handled;
  }

  private async process(event: Event): Promise<{ outcome: Outcome; keep: boolean }> {
    if (!this.isSelfhealEvent(event)) {
      return { outcome: "skipped", keep: false };
    }

    const c: Ctx = { event, auditId: await this.d.audit.start(event), keep: false };
    let r: Result;
    try {
      r = await this.run(c);
      if (r.outcome === "pending") await this.enqueue(c);
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return { outcome: r.outcome, keep: c.keep };
  }

  private async enqueue(c: Ctx): Promise<void> {
    await this.d.state.enqueue(c.event);
    c.keep = true;
  }

  private async withKey(c: Ctx, key: string, write: () => Promise<Result>): Promise<Result> {
    if (this.inFlight.has(key)) return this.heldElsewhere(c);
    this.inFlight.add(key);
    try {
      return await write();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private heldElsewhere(c: Ctx): Result {
    c.keep = true;
    return { outcome: "blocked", reason: "duplicate" };
  }

  private step(c: Ctx, kind: string, data: object): Promise<void> {
    return this.d.audit.append(c.auditId, { kind, data });
  }

  private async run(c: Ctx): Promise<Result> {
    const { event } = c;
    const service = event.service ?? event.doc?.service;
    if (!service) {
      return { outcome: "skipped", reason: "missing_service" };
    }

    const container = this.containers[service];
    if (!container) {
      return { outcome: "failed", reason: "unmapped_service" };
    }

    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    // Inspect container via Docker Engine API
    let inspect: ContainerInspect | null = null;
    let dockerInspectError: string | undefined;
    try {
      inspect = await this.d.docker.inspect(container);
    } catch (err) {
      dockerInspectError = err instanceof Error ? err.message : String(err);
    }

    const recentRestarts = this.tracker.getRestarts(service).length;
    const restartLimitReached = recentRestarts >= 3;

    const facts = {
      service,
      container,
      event_type: event.type,
      container_status: inspect?.status ?? (dockerInspectError ? "docker_error" : "not_found"),
      container_health: inspect?.health ?? "unknown",
      container_running: inspect?.running ?? false,
      exit_code: inspect?.exitCode ?? null,
      restarts_last_10m: recentRestarts,
      restart_limit_reached: restartLimitReached,
      docker_error: dockerInspectError,
      timestamp: event.at,
    };
    await this.step(c, "state", facts);

    // Ask Jev to decide action
    const decision = await this.d.jev.decide(facts, SELFHEAL_QUESTIONS, "selfheal");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "wait") {
      return { outcome: "skipped", reason: "jev_wait" };
    }

    if (action === "restart") {
      // Hard rule: max 3 restarts per service per 10 min
      if (restartLimitReached) {
        await this.step(c, "hard_rule", {
          rule: "max_restarts_per_10m",
          service,
          recentRestarts,
          limit: 3,
          redirected: "escalate",
        });
        return this.handleEscalation(c, service, container, facts, decision, "max_restarts_exceeded");
      }

      const key = `${event.id}:restart`;
      const stopped = await this.d.state.isStopped();
      const done = await this.d.state.isDone(key);
      const verdict = this.d.gate.check({
        group: "selfheal",
        action: "restart",
        actionProb,
        actNow,
        fallback: decision.fallback || !!decision.error,
        stopped,
        key,
        done: done || this.inFlight.has(key),
      });
      await this.step(c, "gate", { key, ...verdict });

      if (verdict.verdict === "blocked") {
        if (verdict.reason === "stopped") await this.enqueue(c);
        if (verdict.reason === "duplicate" && !done) return this.heldElsewhere(c);
        return { outcome: "blocked", reason: verdict.reason };
      }

      if (verdict.verdict === "review") {
        // Low confidence, suggest mode, or fallback: do not restart automatically, escalate to alert
        await this.step(c, "gate_redirect", { reason: verdict.reason, redirected: "escalate" });
        return this.handleEscalation(c, service, container, facts, decision, verdict.reason);
      }

      return this.withKey(c, key, () => this.executeRestart(c, service, container, key, facts, decision));
    }

    if (action === "escalate") {
      return this.handleEscalation(c, service, container, facts, decision, "jev_escalate");
    }

    return { outcome: "failed", reason: "unknown_action" };
  }

  private async handleEscalation(
    c: Ctx,
    service: string,
    container: string,
    facts: object,
    decision: DecideResult,
    reason: string,
  ): Promise<Result> {
    const tool = toolForAction("alert");
    if (!tool) return { outcome: "failed", reason: "alert_tool_not_found" };

    const key = `${c.event.id}:escalate`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: tool.group,
      action: tool.action,
      actionProb: 1,
      actNow: 1,
      fallback: false,
      stopped,
      key,
      done: done || this.inFlight.has(key),
    });
    await this.step(c, "alert_gate", { key, ...verdict });

    if (verdict.verdict === "blocked") {
      if (verdict.reason === "stopped") await this.enqueue(c);
      if (verdict.reason === "duplicate" && !done) return this.heldElsewhere(c);
      return { outcome: "blocked", reason: verdict.reason };
    }

    return this.withKey(c, key, () => this.executeEscalate(c, tool, key, service, container, facts, decision, reason));
  }

  private async executeRestart(
    c: Ctx,
    service: string,
    container: string,
    key: string,
    facts: object,
    decision: DecideResult,
  ): Promise<Result> {
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    // Hard rule double-check inside locked write path
    if (!this.tracker.canRestart(service)) {
      await this.step(c, "hard_rule", { rule: "max_restarts_per_10m", service, limit: 3 });
      return this.handleEscalation(c, service, container, facts, decision, "max_restarts_exceeded");
    }

    const res = await this.d.docker.restart(container);
    await this.step(c, "docker", { action: "restart", container, result: res });

    if (!res.ok) {
      return { outcome: "failed", reason: res.error || "docker_restart_failed" };
    }

    this.tracker.recordRestart(service);
    this.d.gate.record("selfheal");
    await this.d.state.markDone(key);
    return { outcome: "executed", reason: "restarted" };
  }

  private async executeEscalate(
    c: Ctx,
    tool: Tool,
    key: string,
    service: string,
    container: string,
    facts: object,
    decision: DecideResult,
    reason: string,
  ): Promise<Result> {
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    let title = `Service ${service} down - self-heal escalated`;
    let summary = `Service "${service}" (container "${container}") failed health checks. Escalation reason: ${reason}. Human operator intervention required.`;

    if (this.d.llm) {
      try {
        const filled = await this.d.llm.json<unknown>(
          SELFHEAL_ALERT_PROMPT,
          JSON.stringify({ service, container, facts, reason }),
        );
        if (
          typeof filled === "object" &&
          filled !== null &&
          !Array.isArray(filled) &&
          typeof (filled as any).title === "string" &&
          typeof (filled as any).summary === "string"
        ) {
          title = (filled as any).title.slice(0, 200);
          summary = (filled as any).summary.slice(0, 2000);
        }
      } catch {
        // Fallback to deterministic text on LLM failure
      }
    }

    const args: Record<string, unknown> = {
      patient_id: "system",
      source_id: service,
      severity: "CRITICAL",
      title,
      summary,
      jev_probabilities: {
        action: decision.answers.action?.probabilities ?? { [decision.answers.action?.choice ?? "escalate"]: 1 },
        act_now: decision.answers.act_now?.noul ?? 1,
      },
      audit_id: c.auditId,
    };

    const errors = validateArgs(tool, args);
    if (errors.length) {
      await this.step(c, "tool", { tool: tool.name, key, errors });
      return { outcome: "failed", reason: "invalid_args" };
    }

    const result = await tool.run(args, this.d.backend as BackendClient);
    await this.step(c, "tool", { tool: tool.name, key, args, result });

    if (!result.ok) {
      const clientError =
        result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;
      return clientError
        ? { outcome: "failed", reason: "backend_error" }
        : { outcome: "pending", reason: "backend_unavailable" };
    }

    this.d.gate.record(tool.group);
    await this.d.state.markDone(key);
    return { outcome: "executed", reason: "escalated" };
  }
}
