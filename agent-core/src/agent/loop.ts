// Agent loop: Jev decides, Gemini only builds fact-only state and fills text, code enforces safety.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { toolForAction, validateArgs, type Tool } from "../tools/registry.js";

export type Outcome = AuditOutcome;

export const STATE_PROMPT = [
  "You turn a MediCluster patient media record into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"modality\", \"fileName\", \"findings\", \"model\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const ARGS_PROMPT = [
  "You fill the arguments of one MediCluster tool whose action has already been decided.",
  "Return JSON only: {\"tool\": <the given tool name>, \"arguments\": {...}} matching the given schema.",
  "Facts only: write text strictly from the given state; add no diagnosis or treatment advice.",
  "Never choose or change the action or the tool.",
].join("\n");

const URGENCY = ["routine", "urgent", "critical"] as const;
const SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;
const REVIEW_TOOL = "request_review";

export const JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this imaging scan?", {
    analyze: "The scan has no analysis yet and should be analysed by the imaging model.",
    alert: "The analysis shows a finding that a clinician must be alerted to.",
    request_review: "The analysis is uncertain or unusual and needs a clinician to review it.",
    ignore: "Nothing needs to be done for this scan.",
  }),
  urgency: score("How urgent is this scan for the patient?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient"),
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Drop large/derived analysis fields before anything leaves for Gemini or Jev. */
function stripDoc(doc: any): any {
  if (!isObject(doc) || !isObject(doc.analysis)) return doc;
  const { heatmap_data_url: _h, localization: _l, ...analysis } = doc.analysis;
  return { ...doc, analysis };
}

export interface AgentLoopDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  health: { isUp(name: string): boolean };
}

/** `queued` marks that this run put the event (back) on the retry queue. */
type Ctx = { event: Event; doc: any; auditId: string; queued: boolean };
type Result = { outcome: Outcome; reason?: string };
type Stage = "uploaded" | "analyzed";

/** Actions that may execute at each stage; anything else goes to review. */
const STAGE_ACTIONS: Record<Stage, string[]> = { uploaded: ["analyze"], analyzed: ["alert", "request_review"] };

/** The only part of the alert schema Gemini fills; everything else is code-owned. */
const ALERT_TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["title", "summary"],
  additionalProperties: false,
};
const NO_ARGS_SCHEMA = { type: "object", properties: {}, required: [], additionalProperties: false };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export class AgentLoop {
  private readonly d: AgentLoopDeps;
  /** Idempotency keys whose write is in progress in this process. */
  private readonly inFlight = new Set<string>();
  private retrying?: Promise<number>;

  constructor(deps: AgentLoopDeps) {
    this.d = deps;
  }

  async handle(event: Event): Promise<Outcome> {
    return (await this.process(event)).outcome;
  }

  /**
   * Re-handle queued events and ack every one that was not queued again (pending, or blocked
   * by the kill switch). Returns how many were handled. Overlapping calls share one run.
   */
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
      const { queued } = await this.process(e as Event);
      if (!queued) await this.d.state.ack(e.id);
    }
    return events.length;
  }

  private async process(event: Event): Promise<{ outcome: Outcome; queued: boolean }> {
    if (event.type === "service.up" || event.type === "service.down") return { outcome: "skipped", queued: false };
    const doc = stripDoc(event.doc);
    const c: Ctx = { event: { ...event, doc }, doc, auditId: await this.d.audit.start({ ...event, doc }), queued: false };
    let r: Result;
    try {
      r = await this.run(c);
      if (r.outcome === "pending") await this.enqueue(c);
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return { outcome: r.outcome, queued: c.queued };
  }

  private async enqueue(c: Ctx): Promise<void> {
    await this.d.state.enqueue(c.event);
    c.queued = true;
  }

  private step(c: Ctx, kind: string, data: object): Promise<void> {
    return this.d.audit.append(c.auditId, { kind, data });
  }

  private async run(c: Ctx): Promise<Result> {
    const { event, doc } = c;
    if (doc?.file_type !== "image") return { outcome: "skipped", reason: "not_image" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (event.type === "scan.uploaded" && !(this.d.health.isUp("backend") && this.d.health.isUp("ml"))) {
      return { outcome: "pending", reason: "analysis_unavailable" };
    }

    const gemini = await this.llmJson(STATE_PROMPT, JSON.stringify(doc), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }
    // Code-owned facts override any Gemini field of the same name.
    const stage: Stage = event.type === "scan.uploaded" ? "uploaded" : "analyzed";
    const facts = { ...gemini.value, stage, has_analysis: isObject(doc.analysis) && !!doc.analysis.analyzedAt };
    await this.step(c, "state", facts);

    const decision = await this.d.jev.decide(facts, JEV_QUESTIONS, "imaging");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };
    const tool = toolForAction(action);
    if (!tool) return { outcome: "failed", reason: "unknown_action" };

    const key = `${event.id}:${action}`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: tool.group,
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
      return { outcome: "blocked", reason: verdict.reason };
    }
    if (verdict.verdict === "review") return this.review(c, verdict.reason);
    if (!STAGE_ACTIONS[stage].includes(action)) return this.review(c, "stage_not_allowed");
    // Claim the key before the next await so a concurrent run sees it as a duplicate.
    if (this.inFlight.has(key)) return { outcome: "blocked", reason: "duplicate" };
    this.inFlight.add(key);
    try {
      return await this.execute(c, tool, key, answers, facts);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Review on upload is audit-only; on an analysed scan, ask for a clinician review once, if policy allows. */
  private async review(c: Ctx, reason: string): Promise<Result> {
    if (c.event.type !== "scan.analyzed") return { outcome: "review", reason };
    const tool = toolForAction(REVIEW_TOOL)!;
    const key = `${c.event.id}:${REVIEW_TOOL}`;
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: tool.group,
      action: tool.action,
      actionProb: 1,
      actNow: 1,
      fallback: false,
      stopped: false,
      key,
      done: done || this.inFlight.has(key),
    });
    await this.step(c, "review_gate", { key, ...verdict });
    if (verdict.verdict === "blocked") return { outcome: "review", reason };
    this.inFlight.add(key);
    try {
      const r = await this.runTool(c, tool, key, { fileId: c.doc.gridfs_id });
      return r.outcome === "executed" ? { outcome: "review", reason } : r;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async execute(c: Ctx, tool: Tool, key: string, answers: Record<string, Answer>, facts: object): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));
    const isAlert = tool.action === "alert";
    const filled = await this.llmJson(
      ARGS_PROMPT,
      JSON.stringify({
        action: tool.action,
        tool: { name: tool.name, schema: isAlert ? ALERT_TEXT_SCHEMA : NO_ARGS_SCHEMA },
        state: facts,
        urgency: URGENCY[urgencyIdx],
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );
    if (!filled.ok) {
      await this.step(c, "args", { error: filled.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }
    await this.step(c, "args", filled.value);
    if (filled.value.tool !== tool.name) return { outcome: "failed", reason: "llm_tool_mismatch" };

    if (!isAlert) return this.runTool(c, tool, key, { fileId: c.doc.gridfs_id });
    const { title, summary } = filled.value.arguments;
    if (!nonEmpty(title) || !nonEmpty(summary)) return { outcome: "pending", reason: "llm_invalid_text" };
    // Code owns identity and safety fields; the LLM supplies only the text.
    return this.runTool(c, tool, key, {
      patient_id: c.doc.patient_id == null ? undefined : String(c.doc.patient_id),
      source_id: c.event.mediaId,
      severity: SEVERITY[urgencyIdx],
      title: title.slice(0, 200),
      summary: summary.slice(0, 2000),
      jev_probabilities: {
        action: answers.action?.probabilities,
        urgency: answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
    });
  }

  /** The single write path: validate, re-check the kill switch, call, classify, mark done. */
  private async runTool(c: Ctx, tool: Tool, key: string, args: Record<string, unknown>): Promise<Result> {
    const errors = validateArgs(tool, args);
    if (errors.length) {
      await this.step(c, "tool", { tool: tool.name, key, errors });
      return { outcome: "failed", reason: "invalid_args" };
    }
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    const result = await tool.run(args, this.d.backend as BackendClient);
    await this.step(c, "tool", { tool: tool.name, key, args, result });
    if (!result.ok) {
      const clientError = result.status >= 400 && result.status < 500;
      const invalid = result.status === 0 && result.error.startsWith("invalid arguments");
      return clientError || invalid
        ? { outcome: "failed", reason: "backend_error" }
        : { outcome: "pending", reason: "backend_unavailable" };
    }
    this.d.gate.record(tool.group);
    await this.d.state.markDone(key);
    return { outcome: "executed", reason: "ok" };
  }

  /** Gemini call whose result must pass `valid`; provider failures and malformed results are both soft errors. */
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
