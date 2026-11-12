// Agent loop: Jev decides, Gemini only builds fact-only state and fills text, code enforces safety.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { McStore } from "../store/mc.js";
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

export function isRecordPatient(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.trim().length <= 128 && value.trim() !== "imaging-session";
}

export function calculateBackoffMs(attempt: number): number {
  const seconds = Math.min(1800, 60 * Math.pow(2, Math.max(0, attempt - 1)));
  return seconds * 1000;
}

export function chooseAnalysisModel(doc: any): { modelName?: string; reviewOnly?: boolean; reason?: string } {
  const mime = String(doc?.mimetype ?? "").toLowerCase();
  const name = String(doc?.original_name ?? doc?.file_name ?? doc?.fileName ?? "").toLowerCase();
  const modality = String(doc?.modality ?? "").toLowerCase();

  const isBrainOrNifti =
    name.includes("brain") ||
    name.includes("mri") ||
    name.includes(".nii") ||
    name.includes("nifti") ||
    mime.includes("nifti") ||
    modality.includes("brain") ||
    modality.includes("mri");

  if (isBrainOrNifti) {
    return { reviewOnly: true, reason: "brain_or_nifti_requires_review" };
  }

  const isPlainImage =
    mime.startsWith("image/") ||
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp") ||
    modality === "chest-xray";

  if (isPlainImage) {
    return { modelName: "densenet121-res224-all" };
  }

  return { reviewOnly: true, reason: "unsupported_modality" };
}

function sanitizeResult(res: any): any {
  if (!res || typeof res !== "object") return res;
  const clone = { ...res };
  if (isObject(clone.data)) {
    const { heatmap_data_url: _h, localization: _l, ...rest } = clone.data as Record<string, unknown>;
    const dataClone = { ...rest };
    if (isObject(dataClone.analysis)) {
      const { heatmap_data_url: _ah, localization: _al, ...analysisRest } = dataClone.analysis as Record<string, unknown>;
      dataClone.analysis = analysisRest;
    }
    clone.data = dataClone;
  }
  return clone;
}

export interface AgentLoopDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  health: { isUp(name: string): boolean };
  store?: McStore;
}

/**
 * `keep` means retryPending must not ack this event: the run put it (back) on the queue, or it
 * was blocked because another live run holds its key and may still re-enqueue it.
 */
type Ctx = { event: Event; doc: any; auditId: string; keep: boolean };
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
   * Re-handle queued events and ack every one not kept (re-enqueued as pending or blocked by the
   * kill switch, or blocked by a key held by a live run). Returns how many were handled.
   * Overlapping calls share one run.
   */
  retryPending(now?: string): Promise<number> {
    this.retrying ??= this.drainQueue(now).finally(() => {
      this.retrying = undefined;
    });
    return this.retrying;
  }

  private async drainQueue(now = new Date().toISOString()): Promise<number> {
    if (await this.d.state.isStopped()) return 0;
    const events = await this.d.state.drain({ dueOnly: true, now });
    for (const e of events) {
      const { keep } = await this.process(e as Event);
      if (!keep) await this.d.state.ack(e.id);
    }
    return events.length;
  }

  private async process(event: Event): Promise<{ outcome: Outcome; keep: boolean }> {
    if (event.type === "service.up" || event.type === "service.down") return { outcome: "skipped", keep: false };
    const doc = stripDoc(event.doc);
    // Non-image uploads create no audit entries
    if (doc?.file_type !== "image") return { outcome: "skipped", keep: false };
    // Skip re-decisions for the same event.id
    if (await this.d.state.isDecided(event.id)) return { outcome: "skipped", keep: false };

    // On scan.uploaded, do NOT analyze immediately: enqueue with notBefore = uploadedAt + 120s
    if (event.type === "scan.uploaded") {
      const uploadedTime = new Date(doc?.createdAt || doc?.uploadedAt || event.at || 0).getTime();
      const notBeforeTime = uploadedTime + 120_000;
      if (Date.now() < notBeforeTime) {
        const notBefore = new Date(notBeforeTime).toISOString();
        await this.d.state.enqueue(event, notBefore, 0);
        return { outcome: "pending", keep: true };
      }
    }

    const c: Ctx = { event: { ...event, doc }, doc, auditId: await this.d.audit.start({ ...event, doc }), keep: false };
    let r: Result;
    try {
      r = await this.run(c);
      if (r.outcome === "pending") {
        if (r.reason === "delayed_for_upload") {
          c.keep = true;
        } else {
          const item = await this.d.state.getQueueItem(c.event.id);
          const currentAttempts = item?.attempts ?? 0;
          if (currentAttempts >= 10) {
            r = { outcome: "failed", reason: "max_attempts" };
            await this.d.state.markFailed(c.event.id, "max_attempts");
            c.keep = false;
          } else {
            const nextAttempts = currentAttempts + 1;
            const backoffMs = calculateBackoffMs(nextAttempts);
            const notBefore = currentAttempts > 0 ? new Date(Date.now() + backoffMs).toISOString() : undefined;
            await this.d.state.enqueue(c.event, notBefore, nextAttempts);
            c.keep = true;
          }
        }
      }
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);

    if (r.outcome === "executed" || r.outcome === "review" || r.outcome === "skipped" || r.outcome === "failed") {
      await this.d.state.markDecided(c.event.id, r.outcome);
    }

    return { outcome: r.outcome, keep: c.keep };
  }

  private async enqueue(c: Ctx): Promise<void> {
    await this.d.state.enqueue(c.event);
    c.keep = true;
  }

  /**
   * Run `write` holding `key`: has() and add() happen with no await between them, and only the
   * run that added the key releases it. A key held by another live run gives blocked "duplicate".
   */
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
    if (c.doc?.file_type !== "image") return { outcome: "skipped", reason: "not_image" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (event.type === "scan.uploaded" && !(this.d.health.isUp("backend") && this.d.health.isUp("ml"))) {
      return { outcome: "pending", reason: "analysis_unavailable" };
    }

    // When due on scan.uploaded, re-read media doc from store; if now analysed, skip
    if (event.type === "scan.uploaded") {
      if (this.d.store && event.mediaId) {
        const docs = await this.d.store.find("patientmedias", { _id: event.mediaId }, {}, 1);
        if (docs[0]) {
          c.doc = stripDoc(docs[0]);
        }
      }
      if (isObject(c.doc?.analysis) && (c.doc.analysis.analyzedAt || c.doc.analysis.model)) {
        return { outcome: "skipped", reason: "already_analyzed" };
      }
    }

    const doc = c.doc;
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
      if (verdict.reason === "rate_limited") {
        return { outcome: "pending", reason: "rate_limited" };
      }
      if (verdict.reason === "stopped") await this.enqueue(c);
      if (verdict.reason === "duplicate" && !done) return this.heldElsewhere(c);
      return { outcome: "blocked", reason: verdict.reason };
    }
    if (verdict.verdict === "review") return this.review(c, verdict.reason);
    if (!STAGE_ACTIONS[stage].includes(action)) return this.review(c, "stage_not_allowed");
    return this.withKey(c, key, () => this.execute(c, tool, key, answers, facts));
  }

  /** Review on upload is audit-only; on an analysed scan, ask for a clinician review once, if policy allows. */
  private async review(c: Ctx, reason: string): Promise<Result> {
    if (c.event.type !== "scan.analyzed") return { outcome: "review", reason };
    if (!isRecordPatient(c.doc?.patient_id)) return { outcome: "review", reason };
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
    if (verdict.verdict === "blocked") {
      if (verdict.reason === "rate_limited") {
        return { outcome: "pending", reason: "rate_limited" };
      }
      return verdict.reason === "duplicate" && !done ? this.heldElsewhere(c) : { outcome: "review", reason };
    }
    const r = await this.withKey(c, key, () => this.runTool(c, tool, key, { fileId: c.doc.gridfs_id }));
    return r.outcome === "executed" ? { outcome: "review", reason } : r;
  }

  private async execute(c: Ctx, tool: Tool, key: string, answers: Record<string, Answer>, facts: object): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));
    const isAlert = tool.action === "alert";
    const isAnalyze = tool.action === "analyze";

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

    if (isAnalyze) {
      const modelChoice = chooseAnalysisModel(c.doc);
      if (modelChoice.reviewOnly) {
        return this.review(c, modelChoice.reason ?? "requires_review");
      }
      return this.runTool(c, tool, key, { fileId: c.doc.gridfs_id, model_name: modelChoice.modelName });
    }

    if (!isAlert) return this.runTool(c, tool, key, { fileId: c.doc.gridfs_id });

    if (!isRecordPatient(c.doc?.patient_id)) {
      return this.review(c, "patient_not_recorded");
    }

    const { title, summary } = filled.value.arguments;
    if (!nonEmpty(title) || !nonEmpty(summary)) return { outcome: "pending", reason: "llm_invalid_text" };
    // Code owns identity and safety fields; the LLM supplies only the text.
    return this.runTool(c, tool, key, {
      patient_id: String(c.doc.patient_id),
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
      idem_key: `${c.event.id}:alert`,
    });
  }

  /** The single write path (caller holds `key`): re-read doc, validate, re-check done and kill switch, call, classify, mark done. */
  private async runTool(c: Ctx, tool: Tool, key: string, args: Record<string, unknown>): Promise<Result> {
    // Re-read the doc right before every write
    if (this.d.store && c.event.mediaId) {
      const docs = await this.d.store.find("patientmedias", { _id: c.event.mediaId }, {}, 1);
      if (docs[0]) {
        c.doc = stripDoc(docs[0]);
      }
    }
    if (tool.action === "analyze" && isObject(c.doc?.analysis) && (c.doc.analysis.analyzedAt || c.doc.analysis.model)) {
      return { outcome: "skipped", reason: "already_analyzed" };
    }

    const errors = validateArgs(tool, args);
    if (errors.length) {
      await this.step(c, "tool", { tool: tool.name, key, errors });
      return { outcome: "failed", reason: "invalid_args" };
    }
    // A run that finished and released the key since our gate check has already written.
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    const result = await tool.run(args, this.d.backend as BackendClient);
    await this.step(c, "tool", { tool: tool.name, key, args, result: sanitizeResult(result) });
    if (!result.ok) {
      if (result.status === 429) {
        return { outcome: "pending", reason: "rate_limited" };
      }
      const clientError = result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;
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
