// ECG autonomous agent workflow: Jev decides, Gemini formats fact-only state/text, code enforces safety.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { validateArgs, type Tool } from "../tools/registry.js";
import { ecgAnalyzeTool, validateEcgArgs, type EcgAnalysisResult } from "../tools/ecg.js";

export type Outcome = AuditOutcome;

export const ECG_STATE_PROMPT = [
  "You turn a MediCluster ECG record and model probabilities into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"miProbability\", \"normProbability\", \"sttcProbability\", \"cdProbability\", \"hypProbability\", \"topClass\", \"warning\"}.",
  "Facts only: copy what the record and model output say; add no interpretation, diagnosis or medical advice.",
  "MI probability is a statistical observation from the ECG model, never a clinical diagnosis.",
  "Never choose, suggest or change an action.",
].join("\n");

export const ECG_ARGS_PROMPT = [
  "You fill the arguments of one MediCluster alert tool whose action has already been decided.",
  "Return JSON only: {\"tool\": \"alerts.create\", \"arguments\": {\"title\": \"...\", \"summary\": \"...\"}} matching the schema.",
  "Facts only: write text strictly reporting the observed ECG findings and probabilities; add no diagnosis or treatment advice.",
  "Never choose or change the action or the tool.",
].join("\n");

const URGENCY = ["routine", "urgent", "critical"] as const;
const SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;

export const ECG_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this ECG record?", {
    alert: "The analysis shows potential acute findings (such as elevated MI probability) that a clinician must be alerted to.",
    review: "The analysis is borderline, ambiguous or uncertain and needs a clinician to review it.",
    ignore: "The ECG is normal and nothing needs to be done for this record.",
  }),
  urgency: score("How urgent is this ECG for the patient?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient"),
};

export type EcgEvent = {
  id: string;
  type: "ecg.uploaded" | "ecg.analyzed";
  recordId: string;
  patientId: string;
  doc: any;
  at: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Drop raw 12x1000 signal arrays before sending doc to LLM, Jev or audit */
function stripEcgDoc(doc: any): any {
  if (!isObject(doc)) return doc;
  const { signal: _s, ...rest } = doc;
  return rest;
}

export interface EcgWorkflowDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  health: { isUp(name: string): boolean };
}

type Ctx = { event: EcgEvent; doc: any; rawSignal?: number[][]; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string; analysis?: EcgAnalysisResult };

const ALERT_TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["title", "summary"],
  additionalProperties: false,
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export class EcgWorkflow {
  private readonly d: EcgWorkflowDeps;
  private readonly inFlight = new Set<string>();

  constructor(deps: EcgWorkflowDeps) {
    this.d = deps;
  }

  async handle(event: EcgEvent): Promise<Outcome> {
    return (await this.process(event)).outcome;
  }

  private async process(event: EcgEvent): Promise<{ outcome: Outcome; keep: boolean }> {
    const rawSignal = Array.isArray(event.doc?.signal) ? event.doc.signal : undefined;
    const doc = stripEcgDoc(event.doc);
    const c: Ctx = {
      event: { ...event, doc },
      doc,
      rawSignal,
      auditId: await this.d.audit.start({ ...event, doc }),
      keep: false,
    };
    let r: Result;
    try {
      r = await this.run(c);
      if (r.outcome === "pending") {
        await this.d.state.enqueue(c.event as any);
        c.keep = true;
      }
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return { outcome: r.outcome, keep: c.keep };
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
    const { event, doc } = c;

    if (await this.d.state.isStopped()) {
      await this.d.state.enqueue(c.event as any);
      c.keep = true;
      return { outcome: "blocked", reason: "stopped" };
    }

    if (!this.d.health.isUp("backend")) {
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    // Step 1: Analyze ECG signal if not yet analyzed
    let analysis: EcgAnalysisResult | undefined = isObject(doc.analysis) && isObject(doc.analysis.probabilities)
      ? (doc.analysis as EcgAnalysisResult)
      : undefined;

    if (!analysis) {
      if (!c.rawSignal) {
        return { outcome: "failed", reason: "missing_signal" };
      }
      const analyzeKey = `${event.id}:analyze`;
      const analyzeVerdict = this.d.gate.check({
        group: "ecg",
        action: "analyze",
        actionProb: 1.0,
        actNow: 1.0,
        fallback: false,
        stopped: await this.d.state.isStopped(),
        key: analyzeKey,
        done: await this.d.state.isDone(analyzeKey) || this.inFlight.has(analyzeKey),
      });
      await this.step(c, "gate_analyze", { key: analyzeKey, ...analyzeVerdict });

      if (analyzeVerdict.verdict === "blocked") {
        return { outcome: "blocked", reason: analyzeVerdict.reason };
      }

      const backendResp = await this.d.backend.call("POST", "/api/intelligence/ecg/analyze", {
        signal: c.rawSignal,
        lead_order: doc.lead_order,
      });

      if (!backendResp.ok) {
        await this.step(c, "ecg_analyze_error", { status: backendResp.status, error: backendResp.error });
        return { outcome: "pending", reason: "analysis_unavailable" };
      }

      analysis = backendResp.data as EcgAnalysisResult;
      await this.step(c, "ecg_analyze", analysis);
      await this.d.state.markDone(analyzeKey);
    }

    // Step 2: Build fact-only state for Jev via Gemini LLM
    const factPayload = {
      patientId: event.patientId || doc.patient_id,
      analysis,
      warning: analysis.warning,
    };
    const gemini = await this.llmJson(ECG_STATE_PROMPT, JSON.stringify(factPayload), isObject);
    const facts = {
      patient_id: event.patientId || doc.patient_id,
      mi_probability: analysis.probabilities.MI,
      norm_probability: analysis.probabilities.NORM,
      sttc_probability: analysis.probabilities.STTC,
      cd_probability: analysis.probabilities.CD,
      hyp_probability: analysis.probabilities.HYP,
      top_class: analysis.top,
      warning: analysis.warning || null,
      ...(gemini.ok ? gemini.value : {}),
    };
    await this.step(c, "state", facts);

    // Step 3: Jev decides action, urgency, and act_now
    const decision = await this.d.jev.decide(facts, ECG_JEV_QUESTIONS, "ecg");
    const { answers } = decision;
    const action = answers.action?.choice ?? "review";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") {
      return { outcome: "skipped", reason: "jev_ignore" };
    }

    const key = `${event.id}:${action}`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: "ecg",
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
      if (verdict.reason === "stopped") {
        await this.d.state.enqueue(c.event as any);
        c.keep = true;
      }
      return { outcome: "blocked", reason: verdict.reason };
    }
    if (verdict.verdict === "review" || action === "review") {
      return { outcome: "review", reason: verdict.reason || "jev_review" };
    }

    // Step 4: Execute Alert via code-owned safety fields
    return this.withKey(c, key, () => this.executeAlert(c, key, answers, facts));
  }

  private async executeAlert(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: Record<string, unknown>,
  ): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));

    const filled = await this.llmJson(
      ECG_ARGS_PROMPT,
      JSON.stringify({
        action: "alert",
        tool: { name: "alerts.create", schema: ALERT_TEXT_SCHEMA },
        state: facts,
        urgency: URGENCY[urgencyIdx],
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );

    let title = `ECG Alert: ${facts.top_class || "Abnormal"} observed`;
    let summary = `Model analysis shows top finding ${facts.top_class} with MI probability ${facts.mi_probability}. Urgency: ${URGENCY[urgencyIdx]}.`;
    if (filled.ok && typeof filled.value.arguments.title === "string" && typeof filled.value.arguments.summary === "string") {
      if (nonEmpty(filled.value.arguments.title)) title = filled.value.arguments.title.slice(0, 200);
      if (nonEmpty(filled.value.arguments.summary)) summary = filled.value.arguments.summary.slice(0, 2000);
    }
    await this.step(c, "args", { title, summary });

    // Code strictly owns identity and severity; no treatment actions are executed
    const alertPayload = {
      patient_id: String(c.event.patientId || c.doc.patient_id),
      source_id: c.event.recordId,
      severity: SEVERITY[urgencyIdx],
      title,
      summary,
      jev_probabilities: {
        action: answers.action?.probabilities,
        urgency: answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
    };

    // Recheck kill switch and done immediately before write
    if (await this.d.state.isStopped()) {
      await this.d.state.enqueue(c.event as any);
      c.keep = true;
      return { outcome: "blocked", reason: "stopped" };
    }
    if (await this.d.state.isDone(key)) {
      return { outcome: "blocked", reason: "duplicate" };
    }

    const res = await this.d.backend.call("POST", "/api/alerts/agent", alertPayload);
    if (!res.ok) {
      await this.step(c, "alert_call_failed", { status: res.status, error: res.error });
      return { outcome: "failed", reason: "backend_write_failed" };
    }

    await this.d.state.markDone(key);
    await this.step(c, "alert_created", { key, alertId: (res.data as any)?.alert?._id });
    return { outcome: "executed" };
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
