// Sepsis workflow: monitors patient vitals, scores sepsis risk using PhysioNet 2019 ML model,
// evaluates urgency with Jev, and raises code-owned clinician alerts through Gate safety checks.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { toolForAction, validateArgs, type Tool } from "../tools/registry.js";
import { fetchPatientReadings, formatReadingsToHourlySequence, sepsisScoreTool, type SepsisScoreResult } from "../tools/sepsis.js";

export type Outcome = AuditOutcome;

export const SEPSIS_STATE_PROMPT = [
  "You turn MediCluster patient vitals readings and sepsis risk assessment into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"risk\", \"band\", \"top_factors\", \"latest_vitals\"}.",
  "Facts only: copy what the readings and model score say, add no interpretation, diagnosis or medical advice.",
  "Never choose, suggest or change an action.",
  "Risk is a mathematical score and observation, never a clinical diagnosis.",
].join("\n");

export const SEPSIS_ALERT_PROMPT = [
  "You write the title and summary for a clinician alert regarding an elevated sepsis risk score.",
  "Return JSON only: {\"title\": \"...\", \"summary\": \"...\"}.",
  "Facts only: state the patient vital signs, risk band, score, and factors objectively.",
  "Never state that the patient has sepsis; state the risk score and vital signs only.",
  "Never advise or prescribe medications, treatments or interventions.",
].join("\n");

const URGENCY = ["routine", "urgent", "critical"] as const;
const SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;

export const SEPSIS_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this sepsis assessment?", {
    alert: "The sepsis risk score is elevated and a clinician must be alerted immediately.",
    request_review: "The risk score or vital signs are borderline or uncertain and warrant clinical review.",
    ignore: "The risk score is low and vitals are baseline; no clinician alert is needed.",
  }),
  urgency: score("How urgent is this patient's clinical situation?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient"),
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export interface SepsisWorkflowDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  health: { isUp(name: string): boolean };
}

type Ctx = { event: Event; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string };

export class SepsisWorkflow {
  private readonly d: SepsisWorkflowDeps;
  private readonly inFlight = new Set<string>();

  constructor(deps: SepsisWorkflowDeps) {
    this.d = deps;
  }

  async handle(event: Event): Promise<Outcome> {
    return (await this.process(event)).outcome;
  }

  private async process(event: Event): Promise<{ outcome: Outcome; keep: boolean }> {
    const c: Ctx = {
      event,
      auditId: await this.d.audit.start(event),
      keep: false,
    };
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

  private step(c: Ctx, kind: string, data: object): Promise<void> {
    return this.d.audit.append(c.auditId, { kind, data });
  }

  private async withKey(c: Ctx, key: string, write: () => Promise<Result>): Promise<Result> {
    if (this.inFlight.has(key)) {
      c.keep = true;
      return { outcome: "blocked", reason: "duplicate" };
    }
    this.inFlight.add(key);
    try {
      return await write();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async run(c: Ctx): Promise<Result> {
    const { event } = c;
    const doc = event.doc ?? {};

    // Extract patient ID
    const patientId = doc.patientId ?? doc.patient_id ?? event.mediaId;
    if (!nonEmpty(patientId)) {
      return { outcome: "skipped", reason: "no_patient_id" };
    }

    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    if (!this.d.health.isUp("backend") || !this.d.health.isUp("ml")) {
      return { outcome: "pending", reason: "service_unavailable" };
    }

    // 1. Fetch the last 12 hours of readings from backend allowlisted route
    const readingsRes = await fetchPatientReadings(this.d.backend, patientId);
    if (!readingsRes.ok) {
      await this.step(c, "fetch_readings", { error: readingsRes.error, status: readingsRes.status });
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    let allReadings: any[] = Array.isArray(readingsRes.data) ? readingsRes.data : [];
    // If incoming doc is a new reading not yet returned by backend, append it
    if (doc.value !== undefined || doc.heart_rate !== undefined || doc.HR !== undefined) {
      allReadings = [...allReadings, doc];
    }

    const hours = formatReadingsToHourlySequence(allReadings);
    if (hours.length === 0) {
      await this.step(c, "readings_window", { patientId, count: 0 });
      return { outcome: "skipped", reason: "no_readings_in_window" };
    }
    await this.step(c, "readings_window", { patientId, hour_count: hours.length, latest: hours[hours.length - 1] });

    // 2. Score sepsis risk via sepsis.score tool
    const scoreRes = await sepsisScoreTool.run({ hours }, this.d.backend as BackendClient);
    if (!scoreRes.ok) {
      await this.step(c, "sepsis_score_error", { error: scoreRes.error, status: scoreRes.status });
      return { outcome: "pending", reason: "score_unavailable" };
    }

    const scoreData = scoreRes.data as SepsisScoreResult;
    await this.step(c, "sepsis_score", scoreData);

    // 3. Gemini formats fact-only state for Jev
    const promptInput = {
      patientId,
      risk: scoreData.risk,
      band: scoreData.band,
      top_factors: scoreData.top_factors,
      latest_vitals: hours[hours.length - 1],
    };

    const gemini = await this.llmJson(SEPSIS_STATE_PROMPT, JSON.stringify(promptInput), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    const facts = { ...gemini.value, patientId, risk: scoreData.risk, band: scoreData.band };
    await this.step(c, "state", facts);

    // 4. Jev decides urgency and action
    const decision = await this.d.jev.decide(facts, SEPSIS_JEV_QUESTIONS, "sepsis");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") {
      return { outcome: "skipped", reason: "jev_ignore" };
    }

    // Treatment actions (prescribe/dose/diagnose) are never executed
    if (action !== "alert" && action !== "request_review") {
      return { outcome: "failed", reason: "unsupported_action" };
    }

    const readingKeyId = doc._id ?? doc.takenAt ?? new Date().toISOString().slice(0, 13);
    const key = `sepsis:${patientId}:${readingKeyId}:${action}`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);

    // 5. Gate checks policy ("sepsis: auto") and rate limits
    const verdict = this.d.gate.check({
      group: "sepsis",
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
      if (verdict.reason === "duplicate" && !done) {
        c.keep = true;
        return { outcome: "blocked", reason: "duplicate" };
      }
      return { outcome: "blocked", reason: verdict.reason };
    }

    if (verdict.verdict === "review" || action === "request_review") {
      return { outcome: "review", reason: verdict.reason || "clinician_review" };
    }

    return this.withKey(c, key, () => this.executeAlert(c, key, answers, facts, scoreData, patientId));
  }

  private async executeAlert(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: object,
    scoreData: SepsisScoreResult,
    patientId: string,
  ): Promise<Result> {
    const alertTool = toolForAction("alert");
    if (!alertTool) return { outcome: "failed", reason: "alert_tool_missing" };

    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));

    // Fill alert text using LLM
    const textRes = await this.llmJson(
      SEPSIS_ALERT_PROMPT,
      JSON.stringify({ facts, score: scoreData, urgency: URGENCY[urgencyIdx] }),
      (v): v is { title: string; summary: string } =>
        isObject(v) && typeof v.title === "string" && typeof v.summary === "string",
    );

    let title: string;
    let summary: string;

    if (textRes.ok && nonEmpty(textRes.value.title) && nonEmpty(textRes.value.summary)) {
      title = textRes.value.title;
      summary = textRes.value.summary;
    } else {
      // Fallback deterministic text (facts only, no diagnosis)
      title = `Elevated Sepsis Risk Score (${scoreData.band.toUpperCase()}: ${scoreData.risk.toFixed(2)})`;
      summary = `Patient vitals sequence indicated an elevated sepsis risk score of ${scoreData.risk.toFixed(2)} (${scoreData.band} band). Contributing factors: ${scoreData.top_factors.join(", ")}.`;
    }

    await this.step(c, "alert_text", { title, summary });

    // Validate args against alert tool schema
    const alertArgs = {
      patient_id: String(patientId),
      source_id: key,
      severity: SEVERITY[urgencyIdx],
      title: title.slice(0, 200),
      summary: summary.slice(0, 2000),
      jev_probabilities: {
        action: answers.action?.probabilities,
        urgency: answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
    };

    const errors = validateArgs(alertTool, alertArgs);
    if (errors.length) {
      await this.step(c, "alert_tool", { key, errors });
      return { outcome: "failed", reason: "invalid_args" };
    }

    // Re-check kill switch and done status before network write
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    const writeRes = await alertTool.run(alertArgs, this.d.backend as BackendClient);
    await this.step(c, "alert_tool", { key, args: alertArgs, result: writeRes });

    if (!writeRes.ok) {
      const clientError = writeRes.status >= 400 && writeRes.status < 500 && writeRes.status !== 408 && writeRes.status !== 429;
      return clientError ? { outcome: "failed", reason: "backend_error" } : { outcome: "pending", reason: "backend_unavailable" };
    }

    this.d.gate.record("sepsis");
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
