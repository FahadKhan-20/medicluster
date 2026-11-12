// Reminders workflow: missed doses detection, Jev decisions, safety gating, and notification/escalation.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import { toolForReminderAction, type ReminderToolResult } from "../tools/reminders.js";
import { validateArgs, type Tool } from "../tools/registry.js";
import type { McStore } from "../store/mc.js";

export type Outcome = AuditOutcome;

export type MissedDose = {
  reminderId: string;
  patientId: string;
  medicationName: string;
  dosage: string;
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM"
  due: Date;
  frequency: string;
  days?: string[];
  notes?: string;
  pillsLeft?: number | null;
};

export const REMINDER_STATE_PROMPT = [
  "You turn a MediCluster medication reminder and missed dose record into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"medicationName\", \"dosage\", \"scheduledDate\", \"scheduledTime\", \"frequency\", \"days\", \"pillsLeft\", \"notes\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const REMINDER_ARGS_PROMPT = [
  "You fill the arguments of one MediCluster tool whose action has already been decided.",
  "Return JSON only: {\"tool\": <the given tool name>, \"arguments\": {...}} matching the given schema.",
  "Facts only: write text strictly from the given state; add no diagnosis or treatment advice.",
  "Never choose or change the action or the tool.",
].join("\n");

const URGENCY = ["routine", "urgent", "critical"] as const;
const SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;

export const REMINDER_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this missed dose?", {
    notify_patient: "Notify the patient with a reminder notification to take their scheduled medication.",
    escalate_alert: "The missed dose poses a clinical risk or has repeated/prolonged delays; escalate to a clinician alert.",
    ignore: "No action is needed for this missed dose (e.g. within normal variance or not clinically significant).",
  }),
  urgency: score("How urgent is this missed medication dose?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient"),
};

const HOUR = 3_600_000;
const DOSE_GRACE_MS = 30 * 60_000; // a dose counts as missed 30 min after it was due
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Identify missed doses for a reminder schedule, matching alertRoutes missedDoseAlerts logic. */
export function findMissedDoses(reminder: any, now: Date = new Date()): MissedDose[] {
  if (!reminder || !reminder.active || reminder.frequency === "as-needed") return [];
  const missed: MissedDose[] = [];
  const nowMs = now.getTime();
  const createdAt = reminder.createdAt ? new Date(reminder.createdAt).getTime() : 0;

  for (const back of [1, 0]) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    if (reminder.frequency === "weekly" && !(reminder.days || []).includes(WEEKDAYS[day.getDay()])) continue;
    const date = dateKey(day);
    for (const time of reminder.times || []) {
      const [h, m] = String(time).split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) continue;
      const due = new Date(day);
      due.setHours(h, m, 0, 0);
      const dueMs = due.getTime();
      if (dueMs < createdAt || dueMs > nowMs - DOSE_GRACE_MS || dueMs < nowMs - 24 * HOUR) continue;
      if ((reminder.doseLog || []).some((l: any) => l.date === date && l.time === time)) continue;
      missed.push({
        reminderId: String(reminder._id),
        patientId: String(reminder.patientId),
        medicationName: String(reminder.medicationName),
        dosage: reminder.dosage || "",
        date,
        time,
        due,
        frequency: reminder.frequency || "daily",
        days: reminder.days || [],
        notes: reminder.notes || "",
        pillsLeft: reminder.pillsLeft,
      });
    }
  }
  return missed;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const NOTIFY_TEXT_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["message"],
  additionalProperties: false,
};

const ALERT_TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["title", "summary"],
  additionalProperties: false,
};

export interface RemindersWorkflowDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  backend: Pick<BackendClient, "call">;
  store?: McStore;
  health?: { isUp(name: string): boolean };
  now?: () => Date;
}

type Ctx = { event: Event; missed: MissedDose; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string };

export class RemindersWorkflow {
  private readonly d: RemindersWorkflowDeps;
  private readonly inFlight = new Set<string>();
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: RemindersWorkflowDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Handle a single missed dose event. */
  async handleMissedDose(missed: MissedDose): Promise<Result> {
    const eventId = `dose:${missed.reminderId}:${missed.date}:${missed.time}`;
    const event: Event = {
      id: eventId,
      type: "reminder.missed" as any,
      at: this.now().toISOString(),
      doc: missed,
    };
    const c: Ctx = {
      event,
      missed,
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
    return r;
  }

  /** Process all missed doses detected on a reminder document. */
  async handleReminderDoc(reminderDoc: any, at: Date = this.now()): Promise<Result[]> {
    const missed = findMissedDoses(reminderDoc, at);
    const results: Result[] = [];
    for (const m of missed) {
      results.push(await this.handleMissedDose(m));
    }
    return results;
  }

  /** Realtime row handler on the reminders collection. */
  async handleRealtimeRow(row: { collection: string; data: any }): Promise<Result[]> {
    if (row?.collection !== "reminders") return [];
    return this.handleReminderDoc(row.data);
  }

  /** Check all active reminders in the store. */
  async checkAll(at: Date = this.now()): Promise<{ checked: number; results: Result[] }> {
    if (!this.d.store) return { checked: 0, results: [] };
    const reminders = await this.d.store.find("reminders", { active: true });
    const results: Result[] = [];
    for (const r of reminders) {
      const res = await this.handleReminderDoc(r, at);
      results.push(...res);
    }
    return { checked: reminders.length, results };
  }

  startPeriodic(intervalMs = 10 * 60 * 1000): void {
    this.stopPeriodic();
    this.timer = setInterval(() => {
      void this.checkAll().catch((err) => console.error("[reminders-workflow] periodic check failed", err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
    const { missed, event } = c;
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    const gemini = await this.llmJson(REMINDER_STATE_PROMPT, JSON.stringify(missed), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    // Code-owned facts strictly override any Gemini hallucination.
    const facts = {
      ...gemini.value,
      reminderId: missed.reminderId,
      patientId: missed.patientId,
      medicationName: missed.medicationName,
      dosage: missed.dosage,
      scheduledDate: missed.date,
      scheduledTime: missed.time,
      frequency: missed.frequency,
      pillsLeft: missed.pillsLeft,
    };
    await this.step(c, "state", facts);

    const decision = await this.d.jev.decide(facts, REMINDER_JEV_QUESTIONS, "reminders");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };
    const tool = toolForReminderAction(action);
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
      if (verdict.reason === "duplicate" && !done) return this.heldElsewhere(c);
      return { outcome: "blocked", reason: verdict.reason };
    }
    if (verdict.verdict === "review") {
      return { outcome: "review", reason: verdict.reason };
    }

    return this.withKey(c, key, () => this.execute(c, tool, key, answers, facts));
  }

  private async execute(
    c: Ctx,
    tool: Tool,
    key: string,
    answers: Record<string, Answer>,
    facts: object,
  ): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));
    const isAlert = tool.name === "alerts.create" || (tool.action as string) === "escalate_alert";
    const textSchema = isAlert ? ALERT_TEXT_SCHEMA : NOTIFY_TEXT_SCHEMA;

    const filled = await this.llmJson(
      REMINDER_ARGS_PROMPT,
      JSON.stringify({
        action: tool.action,
        tool: { name: tool.name, schema: textSchema },
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

    if (isAlert) {
      const { title, summary } = filled.value.arguments;
      if (!nonEmpty(title) || !nonEmpty(summary)) return { outcome: "pending", reason: "llm_invalid_text" };
      return this.runTool(c, tool, key, {
        patient_id: c.missed.patientId,
        source_id: c.event.id,
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

    const { message } = filled.value.arguments;
    if (!nonEmpty(message)) return { outcome: "pending", reason: "llm_invalid_text" };
    return this.runTool(c, tool, key, {
      reminder_id: c.missed.reminderId,
      patient_id: c.missed.patientId,
      date: c.missed.date,
      time: c.missed.time,
      message: message.slice(0, 2000),
      audit_id: c.auditId,
    });
  }

  private async runTool(
    c: Ctx,
    tool: Tool,
    key: string,
    args: Record<string, unknown>,
  ): Promise<Result> {
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
    this.d.gate.record(tool.group);
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

export function registerRemindersWorkflow(deps: RemindersWorkflowDeps): RemindersWorkflow {
  const workflow = new RemindersWorkflow(deps);
  workflow.startPeriodic();
  return workflow;
}
