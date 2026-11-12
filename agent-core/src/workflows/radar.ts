// Deterioration Radar workflow: Jev scores deterioration risk and decides alert|review|ignore.
// Code enforces safety, Gemini builds fact-only state, code owns alert severity.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { RealtimePayload, Row, Subscribe } from "../events/events.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { toolForAction, validateArgs, type Tool } from "../tools/registry.js";
import { fetchRadarForecast, radarForecastTool } from "../tools/radar.js";

export type Outcome = AuditOutcome;

export type RadarEvent = {
  id: string;
  type: string;
  readingId?: string;
  patientId?: string;
  sessionId?: string;
  doc: any;
  at: string;
};

export const RADAR_STATE_PROMPT = [
  "You turn a MediCluster vital reading and deterioration forecast record into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"score\", \"tier\", \"vitals\", \"forecastSummary\", \"warnings\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const RADAR_ARGS_PROMPT = [
  "You fill the arguments of one MediCluster tool whose action has already been decided.",
  "Return JSON only: {\"tool\": <the given tool name>, \"arguments\": {...}} matching the given schema.",
  "Facts only: write text strictly from the given state; add no diagnosis or treatment advice.",
  "Never choose or change the action or the tool.",
].join("\n");

export const RADAR_RISK = ["routine", "urgent", "critical"] as const;
export const RADAR_SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;

export const RADAR_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this vital sign and deterioration assessment?", {
    alert: "The deterioration risk or forecast trend requires immediate clinical attention and an alert should be created.",
    review: "The readings or forecast are borderline, ambiguous, or uncertain, requiring clinical review.",
    ignore: "The patient is stable or normal; no clinical alert or action is needed.",
  }),
  risk: score("What is the deterioration risk for this patient based on current vitals and forecast?", [...RADAR_RISK]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient"),
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Drop massive series arrays before sending forecast data to Gemini or Jev. */
function stripForecast(data: any): any {
  if (!isObject(data)) return data;
  const { series: _s, readings: _r, ...restForecast } = isObject(data.forecast) ? data.forecast : ({} as any);
  return {
    patientId: data.patientId,
    sessionId: data.id,
    score: data.score,
    warnings: restForecast.warnings,
    steps: restForecast.steps,
    model: restForecast.model,
  };
}

const ALERT_TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["title", "summary"],
  additionalProperties: false,
};

export const READINGS_COLLECTION = "readings";

export function readingRowToEvent(row: Row, old?: any): RadarEvent | null {
  if (row?.collection !== READINGS_COLLECTION && row?.collection !== "vitals") return null;
  const doc = row.data;
  const readingId = doc?._id || doc?.id;
  if (typeof readingId !== "string" && typeof readingId !== "number") return null;
  const strId = String(readingId);
  return {
    id: `${strId}:${doc.takenAt || doc.createdAt || doc.timestamp || "new"}`,
    type: "reading.created",
    readingId: strId,
    patientId: doc.patientId ? String(doc.patientId) : doc.patient_id ? String(doc.patient_id) : undefined,
    sessionId: doc.sessionId ? String(doc.sessionId) : doc.session_id ? String(doc.session_id) : undefined,
    doc,
    at: new Date().toISOString(),
  };
}

export interface RadarWorkflowDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  health: { isUp(name: string): boolean };
}

type Ctx = { event: RadarEvent; doc: any; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string };

export class RadarWorkflow {
  private readonly d: RadarWorkflowDeps;
  private readonly inFlight = new Set<string>();
  private retrying?: Promise<number>;

  constructor(deps: RadarWorkflowDeps) {
    this.d = deps;
  }

  async handle(event: RadarEvent): Promise<Outcome> {
    return (await this.process(event)).outcome;
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
    for (const e of events) {
      const { keep } = await this.process(e as RadarEvent);
      if (!keep) await this.d.state.ack(e.id);
    }
    return events.length;
  }

  private async process(event: RadarEvent): Promise<{ outcome: Outcome; keep: boolean }> {
    if (event.type === "service.up" || event.type === "service.down") return { outcome: "skipped", keep: false };
    const doc = event.doc;
    const c: Ctx = { event, doc, auditId: await this.d.audit.start({ ...event, doc }), keep: false };
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
    const { event, doc } = c;
    if (!isObject(doc)) return { outcome: "skipped", reason: "not_reading" };
    if (doc.file_type === "image") return { outcome: "skipped", reason: "not_vitals" };

    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    if (!(this.d.health.isUp("backend") && this.d.health.isUp("intelligence"))) {
      return { outcome: "pending", reason: "radar_unavailable" };
    }

    const sessionId = doc.sessionId || doc.session_id || event.sessionId || doc.radarSessionId || doc.patientId || doc.patient_id || doc._id;
    if (!sessionId) return { outcome: "skipped", reason: "no_session" };

    // Call backend radar forecast endpoint as the agent
    const forecastRes = await fetchRadarForecast(this.d.backend, String(sessionId));
    if (!forecastRes.ok) {
      await this.step(c, "forecast", { error: forecastRes.error, status: forecastRes.status });
      const clientError = forecastRes.status >= 400 && forecastRes.status < 500 && forecastRes.status !== 408 && forecastRes.status !== 429;
      return clientError
        ? { outcome: "failed", reason: "forecast_error" }
        : { outcome: "pending", reason: "forecast_unavailable" };
    }

    const forecastData = forecastRes.data as any;
    await this.step(c, "forecast", { sessionId, score: forecastData?.score, warnings: forecastData?.forecast?.warnings });

    // Fact-only extraction via Gemini
    const gemini = await this.llmJson(RADAR_STATE_PROMPT, JSON.stringify(stripForecast(forecastData)), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    const facts = {
      ...gemini.value,
      patientId: forecastData?.patientId || doc?.patientId || doc?.patient_id || "unknown",
      sessionId: String(sessionId),
      score_value: forecastData?.score?.value,
      score_tier: forecastData?.score?.tier,
      has_forecast: isObject(forecastData?.forecast),
    };
    await this.step(c, "state", facts);

    // Jev decision
    const decision = await this.d.jev.decide(facts, RADAR_JEV_QUESTIONS, "radar");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };
    if (!["alert", "review"].includes(action)) return { outcome: "failed", reason: "unknown_action" };

    const key = `${event.id}:${action}`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);

    const verdict = this.d.gate.check({
      group: "radar",
      action,
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
    if (verdict.verdict === "review" || action === "review") {
      return { outcome: "review", reason: verdict.verdict === "review" ? verdict.reason : "jev_review" };
    }

    return this.withKey(c, key, () => this.executeAlert(c, key, answers, facts, forecastData, String(sessionId)));
  }

  private async executeAlert(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: object,
    forecastData: any,
    sessionId: string,
  ): Promise<Result> {
    const rawScore = answers.risk?.score ?? answers.urgency?.score ?? 0;
    const riskIdx = Math.min(2, Math.max(0, Math.round(rawScore)));
    const filled = await this.llmJson(
      RADAR_ARGS_PROMPT,
      JSON.stringify({
        action: "alert",
        tool: { name: "alerts.create", schema: ALERT_TEXT_SCHEMA },
        state: facts,
        risk: RADAR_RISK[riskIdx],
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );
    if (!filled.ok) {
      await this.step(c, "args", { error: filled.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }
    await this.step(c, "args", filled.value);
    if (filled.value.tool !== "alerts.create") return { outcome: "failed", reason: "llm_tool_mismatch" };

    const { title, summary } = filled.value.arguments;
    if (!nonEmpty(title) || !nonEmpty(summary)) return { outcome: "pending", reason: "llm_invalid_text" };

    const tool = toolForAction("alert");
    if (!tool) return { outcome: "failed", reason: "unknown_action" };

    return this.runTool(c, tool, key, {
      patient_id: String(forecastData?.patientId || c.doc?.patientId || c.doc?.patient_id || "unknown"),
      source_id: sessionId,
      severity: RADAR_SEVERITY[riskIdx],
      title: title.slice(0, 200),
      summary: summary.slice(0, 2000),
      jev_probabilities: {
        action: answers.action?.probabilities,
        risk: answers.risk?.probabilities || answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
    });
  }

  private async runTool(c: Ctx, tool: Tool, key: string, args: Record<string, unknown>): Promise<Result> {
    const errors = validateArgs(tool, args);
    if (errors.length) {
      await this.step(c, "tool", { tool: tool.name, key, errors });
      return { outcome: "failed", reason: "invalid_args" };
    }
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    const result = await tool.run(args, this.d.backend as BackendClient);
    await this.step(c, "tool", { tool: tool.name, key, args, result });
    if (!result.ok) {
      const clientError = result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;
      const invalid = result.status === 0 && result.error.startsWith("invalid arguments");
      return clientError || invalid
        ? { outcome: "failed", reason: "backend_error" }
        : { outcome: "pending", reason: "backend_unavailable" };
    }
    this.d.gate.record("radar");
    await this.d.state.markDone(key);
    return { outcome: "executed", reason: "ok" };
  }

  private async llmJson<T>(
    system: string,
    user: string,
    valid: (v: unknown) => v is T,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      const v = await this.d.llm.json<unknown>(system, user);
      if (!valid(v)) throw new ProviderError("model reply had the wrong shape");
      return { ok: true, value: v };
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, error: e.message };
      throw e;
    }
  }
}

export interface RegisterRadarWorkflowDeps extends RadarWorkflowDeps {
  subscribe?: Subscribe;
  work?: { wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R> };
}

export function registerRadarWorkflow(deps: RegisterRadarWorkflowDeps): RadarWorkflow {
  const workflow = new RadarWorkflow(deps);
  if (deps.subscribe) {
    const handleEvent = deps.work
      ? deps.work.wrap((e: RadarEvent) => workflow.handle(e).then(() => undefined))
      : (e: RadarEvent) => workflow.handle(e).then(() => undefined);
    deps.subscribe((payload: RealtimePayload) => {
      const isInsert = payload.eventType === "INSERT";
      const event = readingRowToEvent(payload.new, isInsert ? undefined : (payload.old ?? {}));
      if (event) void handleEvent(event);
    });
  }
  return workflow;
}
