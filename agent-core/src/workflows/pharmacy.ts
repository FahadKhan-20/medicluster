// Pharmacy workflow: stock monitoring, stuck orders detection, missed-dose refill suggestions, Jev decisions, safety gating, and audit.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, score, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import type { BackendClient } from "../tools/backend.js";
import {
  fetchLowStock,
  fetchStuckOrders,
  pharmacyAlertTool,
  pharmacyRefillSuggestionTool,
  type StockItem,
  type StuckOrderItem,
} from "../tools/pharmacy.js";
import { validateArgs, type Tool } from "../tools/registry.js";
import type { McStore } from "../store/mc.js";
import { findMissedDoses, type MissedDose } from "./reminders.js";

export type Outcome = AuditOutcome;

export const PHARMACY_STOCK_STATE_PROMPT = [
  "You turn a MediCluster pharmacy stock item into a fact-only state for a decision model.",
  "Return JSON only: {\"pharmacyId\", \"drug\", \"strength\", \"quantity\", \"lowStockThreshold\", \"deficit\", \"batch\", \"expiry\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const PHARMACY_ORDER_STATE_PROMPT = [
  "You turn a MediCluster stuck pharmacy order record into a fact-only state for a decision model.",
  "Return JSON only: {\"orderId\", \"pharmacyId\", \"patientId\", \"status\", \"fulfilment\", \"itemCount\", \"hoursInCurrentState\", \"stuckReason\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const PHARMACY_REFILL_STATE_PROMPT = [
  "You turn a MediCluster missed-dose reminder with no remaining refills or active orders into a fact-only state for a decision model.",
  "Return JSON only: {\"patientId\", \"reminderId\", \"medicationName\", \"dosage\", \"pillsLeft\", \"refillsRemaining\", \"hasActiveOrder\", \"missedDate\", \"missedTime\"}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or advice.",
  "Never choose, suggest or change an action.",
].join("\n");

export const PHARMACY_ARGS_PROMPT = [
  "You fill the arguments of one MediCluster tool whose action has already been decided.",
  "Return JSON only: {\"tool\": <the given tool name>, \"arguments\": {...}} matching the given schema.",
  "Facts only: write text strictly from the given state; add no diagnosis or treatment advice.",
  "Never choose or change the action or the tool.",
].join("\n");

const URGENCY = ["routine", "urgent", "critical"] as const;
const SEVERITY = ["WARNING", "HIGH", "CRITICAL"] as const;

export const STOCK_LOW_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this low-stock pharmacy item?", {
    alert: "Alert the pharmacy staff that stock for this medication is critically or significantly below threshold.",
    ignore: "No alert needed; stock deficit is negligible or within safe buffer.",
  }),
  urgency: score("How urgent is this low stock situation?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this pharmacy"),
};

export const STUCK_ORDERS_JEV_QUESTIONS = {
  action: choice("Which action should the agent take for this stuck pharmacy order?", {
    alert: "Alert the pharmacy and clinician to expedite or unstick this delayed order.",
    ignore: "No alert needed; delay is minor or within acceptable clinical SLA tolerances.",
  }),
  urgency: score("How urgent is this stuck order alert?", [...URGENCY]),
  act_now: noul("Acting now on the chosen action is safe and correct for this patient and order"),
};

export const REFILL_SUGGESTION_JEV_QUESTIONS = {
  action: choice("Should a refill suggestion be sent to the clinician for this missed dose?", {
    suggest_refill: "Send a refill suggestion to the clinician for confirmation because the patient missed a dose with no remaining refills or active orders.",
    ignore: "Do not suggest a refill at this time.",
  }),
  urgency: score("How urgent is this refill suggestion for the clinician?", [...URGENCY]),
  act_now: noul("Sending this refill suggestion to the clinician is safe and clinically indicated"),
};

const pad = (n: number) => String(n).padStart(2, "0");
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const ALERT_TEXT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["title", "summary"],
  additionalProperties: false,
};

const REFILL_TEXT_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["reason"],
  additionalProperties: false,
};

export interface PharmacyWorkflowDeps {
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

export type PharmacyItemType = "stock" | "order" | "refill";

type Ctx = {
  event: Event;
  type: PharmacyItemType;
  raw: any;
  auditId: string;
  keep: boolean;
};

export type Result = { outcome: Outcome; reason?: string };

export class PharmacyWorkflow {
  private readonly d: PharmacyWorkflowDeps;
  private readonly inFlight = new Set<string>();
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;
  private retrying?: Promise<number>;

  constructor(deps: PharmacyWorkflowDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Periodic polling: stock-low, stuck-orders, and missed-dose refill suggestions. */
  startPeriodic(intervalMs = 5 * 60 * 1000): void {
    this.stopPeriodic();
    // Run immediately on start
    void this.checkAll().catch((err) =>
      console.error("[pharmacy-workflow] initial check failed", err),
    );
    this.timer = setInterval(() => {
      void this.checkAll().catch((err) =>
        console.error("[pharmacy-workflow] periodic check failed", err),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Retry pending queued pharmacy events drained from state. */
  retryPending(): Promise<number> {
    this.retrying ??= this.drainQueue().finally(() => {
      this.retrying = undefined;
    });
    return this.retrying;
  }

  private async drainQueue(): Promise<number> {
    if (await this.d.state.isStopped()) return 0;
    const events = await this.d.state.drain();
    let processed = 0;
    for (const e of events) {
      if (typeof e.type === "string" && e.type.startsWith("pharmacy.")) {
        const res = await this.processQueuedEvent(e as Event);
        if (!res.keep) {
          await this.d.state.ack(e.id);
        }
        processed++;
      }
    }
    return processed;
  }

  private async processQueuedEvent(event: Event): Promise<{ keep: boolean; result: Result }> {
    const typeStr = event.type as string;
    if (typeStr === "pharmacy.stock_low") {
      const res = await this.handleStockItem(event.doc as StockItem);
      return { keep: res.outcome === "pending", result: res };
    }
    if (typeStr === "pharmacy.stuck_order") {
      const res = await this.handleStuckOrder(event.doc as StuckOrderItem);
      return { keep: res.outcome === "pending", result: res };
    }
    if (typeStr === "pharmacy.refill_needed") {
      const res = await this.handleMissedDoseRefill(event.doc);
      return { keep: res.outcome === "pending", result: res };
    }
    return { keep: false, result: { outcome: "skipped", reason: "unknown_event_type" } };
  }

  /** Run all three pharmacy ops checks: stock-low, stuck-orders, and missed-dose refill suggestions. */
  async checkAll(at: Date = this.now()): Promise<{
    stockChecked: number;
    ordersChecked: number;
    refillsChecked: number;
    results: Result[];
  }> {
    const results: Result[] = [];
    const stockResults = await this.checkStockLow(at);
    results.push(...stockResults.results);

    const orderResults = await this.checkStuckOrders(at);
    results.push(...orderResults.results);

    const refillResults = await this.checkRefillSuggestions(at);
    results.push(...refillResults.results);

    return {
      stockChecked: stockResults.checked,
      ordersChecked: orderResults.checked,
      refillsChecked: refillResults.checked,
      results,
    };
  }

  /** Check low stock items via GET /api/pharmacy/agent/stock-low */
  async checkStockLow(at: Date = this.now()): Promise<{ checked: number; results: Result[] }> {
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { checked: 0, results: [{ outcome: "pending", reason: "backend_unavailable" }] };
    }
    const res = await fetchLowStock(this.d.backend);
    if (!res.ok) {
      return { checked: 0, results: [{ outcome: "pending", reason: "backend_error" }] };
    }
    const items: StockItem[] = Array.isArray((res.data as any)?.items) ? (res.data as any).items : [];
    const results: Result[] = [];
    for (const item of items) {
      results.push(await this.handleStockItem(item, at));
    }
    return { checked: items.length, results };
  }

  /** Check stuck orders via GET /api/pharmacy/agent/stuck-orders */
  async checkStuckOrders(at: Date = this.now()): Promise<{ checked: number; results: Result[] }> {
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { checked: 0, results: [{ outcome: "pending", reason: "backend_unavailable" }] };
    }
    const res = await fetchStuckOrders(this.d.backend);
    if (!res.ok) {
      return { checked: 0, results: [{ outcome: "pending", reason: "backend_error" }] };
    }
    const items: StuckOrderItem[] = Array.isArray((res.data as any)?.items) ? (res.data as any).items : [];
    const results: Result[] = [];
    for (const order of items) {
      results.push(await this.handleStuckOrder(order, at));
    }
    return { checked: items.length, results };
  }

  /** Check reminders for missed doses with no remaining refills/active orders. */
  async checkRefillSuggestions(at: Date = this.now()): Promise<{ checked: number; results: Result[] }> {
    if (!this.d.store) return { checked: 0, results: [] };
    const reminders = await this.d.store.find("reminders", { active: true });
    const results: Result[] = [];
    let checked = 0;

    for (const reminder of reminders) {
      const missed = findMissedDoses(reminder, at);
      if (missed.length === 0) continue;

      // Check if pills left or refills are zero/exhausted
      const pillsLeft = reminder.pillsLeft;
      const refillsRemaining = reminder.refillsRemaining ?? (pillsLeft !== null && pillsLeft <= 0 ? 0 : null);
      const isExhausted = (pillsLeft !== null && pillsLeft <= 0) || refillsRemaining === 0;

      if (!isExhausted) continue;

      // Check if patient already has an active order for this medication
      const activeOrders = await this.d.store.find("pharmacy_orders", {
        patientId: String(reminder.patientId),
        status: { $in: ["new", "accepted", "preparing", "ready", "out_for_delivery"] },
      });
      const hasActiveOrder = activeOrders.some((order: any) =>
        (order.items || []).some(
          (it: any) =>
            String(it.drug || "").toLowerCase() === String(reminder.medicationName || "").toLowerCase(),
        ),
      );

      if (hasActiveOrder) continue;

      checked++;
      for (const m of missed) {
        results.push(
          await this.handleMissedDoseRefill(
            {
              ...m,
              pillsLeft,
              refillsRemaining: 0,
              hasActiveOrder: false,
            },
            at,
          ),
        );
      }
    }

    return { checked, results };
  }

  /** Handle a single low stock item. */
  async handleStockItem(item: StockItem, at: Date = this.now()): Promise<Result> {
    const today = dateKey(at);
    const pharmacyId = String(item.pharmacyId || "unknown");
    const drug = String(item.drug || "unknown");
    const eventId = `pharmacy:stock:${pharmacyId}:${drug}:${today}`;
    const event: Event = {
      id: eventId,
      type: "pharmacy.stock_low" as any,
      at: at.toISOString(),
      doc: item,
    };

    const c: Ctx = {
      event,
      type: "stock",
      raw: item,
      auditId: await this.d.audit.start(event),
      keep: false,
    };

    let r: Result;
    try {
      r = await this.runStock(c, at);
      if (r.outcome === "pending") await this.enqueue(c);
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return r;
  }

  /** Handle a single stuck order. */
  async handleStuckOrder(order: StuckOrderItem, at: Date = this.now()): Promise<Result> {
    const today = dateKey(at);
    const orderId = String(order.orderId || order._id || order.id || "unknown");
    const eventId = `pharmacy:order:${orderId}:${today}`;
    const event: Event = {
      id: eventId,
      type: "pharmacy.stuck_order" as any,
      at: at.toISOString(),
      doc: order,
    };

    const c: Ctx = {
      event,
      type: "order",
      raw: order,
      auditId: await this.d.audit.start(event),
      keep: false,
    };

    let r: Result;
    try {
      r = await this.runOrder(c, at);
      if (r.outcome === "pending") await this.enqueue(c);
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return r;
  }

  /** Handle a single missed-dose refill suggestion. */
  async handleMissedDoseRefill(record: any, at: Date = this.now()): Promise<Result> {
    const today = dateKey(at);
    const reminderId = String(record.reminderId || record._id || "unknown");
    const patientId = String(record.patientId || "unknown");
    const eventId = `pharmacy:refill:${reminderId}:${patientId}:${today}`;
    const event: Event = {
      id: eventId,
      type: "pharmacy.refill_needed" as any,
      at: at.toISOString(),
      doc: record,
    };

    const c: Ctx = {
      event,
      type: "refill",
      raw: record,
      auditId: await this.d.audit.start(event),
      keep: false,
    };

    let r: Result;
    try {
      r = await this.runRefill(c, at);
      if (r.outcome === "pending") await this.enqueue(c);
    } catch (e) {
      await this.d.audit.finish(c.auditId, "failed", "internal_error");
      throw e;
    }
    await this.d.audit.finish(c.auditId, r.outcome, r.reason);
    return r;
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

  // --- Run Stock Evaluation ---
  private async runStock(c: Ctx, at: Date): Promise<Result> {
    const item = c.raw as StockItem;
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    const gemini = await this.llmJson(PHARMACY_STOCK_STATE_PROMPT, JSON.stringify(item), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    const deficit = Math.max(0, (item.lowStockThreshold ?? 0) - (item.quantity ?? 0));
    const facts = {
      ...gemini.value,
      pharmacyId: item.pharmacyId,
      drug: item.drug,
      strength: item.strength,
      quantity: item.quantity,
      lowStockThreshold: item.lowStockThreshold,
      deficit,
      batch: item.batch ?? null,
      expiry: item.expiry ?? null,
    };
    await this.step(c, "state", facts);

    const decision = await this.d.jev.decide(facts, STOCK_LOW_JEV_QUESTIONS, "pharmacy");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };

    const key = `${c.event.id}:alert`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: "pharmacy",
      action: "alert",
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

    return this.withKey(c, key, () => this.executeStockAlert(c, key, answers, facts));
  }

  private async executeStockAlert(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: Record<string, unknown>,
  ): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));
    const tool = pharmacyAlertTool;

    const filled = await this.llmJson(
      PHARMACY_ARGS_PROMPT,
      JSON.stringify({
        action: "alert",
        tool: { name: tool.name, schema: ALERT_TEXT_SCHEMA },
        state: facts,
        urgency: URGENCY[urgencyIdx],
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );

    let title: string;
    let summary: string;

    if (filled.ok && nonEmpty(filled.value.arguments?.title) && nonEmpty(filled.value.arguments?.summary)) {
      await this.step(c, "args", filled.value);
      title = filled.value.arguments.title.slice(0, 200);
      summary = filled.value.arguments.summary.slice(0, 2000);
    } else {
      const defaultTitle = `Low Stock Alert: ${facts.drug} (${facts.strength})`;
      const defaultSummary = `Pharmacy ${facts.pharmacyId} has only ${facts.quantity} units remaining of ${facts.drug} (${facts.strength}), below threshold of ${facts.lowStockThreshold}. Deficit: ${facts.deficit}.`;
      await this.step(c, "args", { title: defaultTitle, summary: defaultSummary, fallback: true });
      title = defaultTitle;
      summary = defaultSummary;
    }

    const payload = {
      patient_id: `pharmacy:${facts.pharmacyId}`,
      source_id: `stock:${facts.pharmacyId}:${facts.drug}`,
      severity: SEVERITY[urgencyIdx],
      title,
      summary,
      jev_probabilities: {
        action: answers.action?.probabilities,
        urgency: answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
      idem_key: key,
    };

    return this.runTool(c, tool, key, payload);
  }

  // --- Run Stuck Order Evaluation ---
  private async runOrder(c: Ctx, at: Date): Promise<Result> {
    const order = c.raw as StuckOrderItem;
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    const gemini = await this.llmJson(PHARMACY_ORDER_STATE_PROMPT, JSON.stringify(order), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    const orderId = order.orderId || order._id || order.id;
    const hours = order.hoursInCurrentState ?? (order.stuckMinutes ? Math.round(order.stuckMinutes / 60) : 0);
    const facts = {
      ...gemini.value,
      orderId,
      pharmacyId: order.pharmacyId,
      patientId: order.patientId,
      status: order.status,
      fulfilment: order.fulfilment ?? "pickup",
      itemCount: Array.isArray(order.items) ? order.items.length : 1,
      hoursInCurrentState: hours,
      stuckReason: order.stuckReason ?? "exceeded SLA duration",
    };
    await this.step(c, "state", facts);

    const decision = await this.d.jev.decide(facts, STUCK_ORDERS_JEV_QUESTIONS, "pharmacy");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };

    const key = `${c.event.id}:alert`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: "pharmacy",
      action: "alert",
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

    return this.withKey(c, key, () => this.executeOrderAlert(c, key, answers, facts));
  }

  private async executeOrderAlert(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: Record<string, unknown>,
  ): Promise<Result> {
    const urgencyIdx = Math.min(2, Math.max(0, Math.round(answers.urgency?.score ?? 0)));
    const tool = pharmacyAlertTool;

    const filled = await this.llmJson(
      PHARMACY_ARGS_PROMPT,
      JSON.stringify({
        action: "alert",
        tool: { name: tool.name, schema: ALERT_TEXT_SCHEMA },
        state: facts,
        urgency: URGENCY[urgencyIdx],
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );

    let title: string;
    let summary: string;

    if (filled.ok && nonEmpty(filled.value.arguments?.title) && nonEmpty(filled.value.arguments?.summary)) {
      await this.step(c, "args", filled.value);
      title = filled.value.arguments.title.slice(0, 200);
      summary = filled.value.arguments.summary.slice(0, 2000);
    } else {
      const defaultTitle = `Stuck Pharmacy Order: ${facts.orderId}`;
      const defaultSummary = `Order ${facts.orderId} at pharmacy ${facts.pharmacyId} has been in status "${facts.status}" for ${facts.hoursInCurrentState} hours without progression.`;
      await this.step(c, "args", { title: defaultTitle, summary: defaultSummary, fallback: true });
      title = defaultTitle;
      summary = defaultSummary;
    }

    const payload = {
      patient_id: facts.patientId ? String(facts.patientId) : `pharmacy:${facts.pharmacyId}`,
      source_id: `order:${facts.orderId}`,
      severity: SEVERITY[urgencyIdx],
      title,
      summary,
      jev_probabilities: {
        action: answers.action?.probabilities,
        urgency: answers.urgency?.probabilities,
        act_now: answers.act_now?.noul,
      },
      audit_id: c.auditId,
      idem_key: key,
    };

    return this.runTool(c, tool, key, payload);
  }

  // --- Run Missed-Dose Refill Suggestion Evaluation ---
  private async runRefill(c: Ctx, at: Date): Promise<Result> {
    const record = c.raw;
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (this.d.health && !this.d.health.isUp("backend")) {
      return { outcome: "pending", reason: "backend_unavailable" };
    }

    const gemini = await this.llmJson(PHARMACY_REFILL_STATE_PROMPT, JSON.stringify(record), isObject);
    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    const reminderId = record.reminderId || record._id;
    const facts = {
      ...gemini.value,
      patientId: record.patientId,
      reminderId,
      medicationName: record.medicationName,
      dosage: record.dosage || "",
      pillsLeft: record.pillsLeft ?? 0,
      refillsRemaining: record.refillsRemaining ?? 0,
      hasActiveOrder: Boolean(record.hasActiveOrder),
      missedDate: record.date || dateKey(at),
      missedTime: record.time || "00:00",
    };
    await this.step(c, "state", facts);

    const decision = await this.d.jev.decide(facts, REFILL_SUGGESTION_JEV_QUESTIONS, "pharmacy");
    const { answers } = decision;
    const action = answers.action?.choice ?? "";
    const actionProb = answers.action?.probabilities?.[action] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;
    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (action === "ignore") return { outcome: "skipped", reason: "jev_ignore" };

    const key = `${c.event.id}:suggest_refill`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: "pharmacy",
      action: "suggest_refill",
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

    return this.withKey(c, key, () => this.executeRefillSuggestion(c, key, answers, facts));
  }

  private async executeRefillSuggestion(
    c: Ctx,
    key: string,
    answers: Record<string, Answer>,
    facts: Record<string, unknown>,
  ): Promise<Result> {
    const tool = pharmacyRefillSuggestionTool;

    const filled = await this.llmJson(
      PHARMACY_ARGS_PROMPT,
      JSON.stringify({
        action: "suggest_refill",
        tool: { name: tool.name, schema: REFILL_TEXT_SCHEMA },
        state: facts,
      }),
      (v): v is { tool: string; arguments: Record<string, unknown> } =>
        isObject(v) && typeof v.tool === "string" && isObject(v.arguments),
    );

    let reason: string;
    if (filled.ok && nonEmpty(filled.value.arguments?.reason)) {
      await this.step(c, "args", filled.value);
      reason = filled.value.arguments.reason.slice(0, 2000);
    } else {
      const defaultReason = `Missed scheduled dose for ${facts.medicationName} (${facts.dosage}) on ${facts.missedDate} with zero pills/refills remaining and no active pharmacy order.`;
      await this.step(c, "args", { reason: defaultReason, fallback: true });
      reason = defaultReason;
    }

    const payload = {
      patientId: String(facts.patientId),
      reminderId: String(facts.reminderId),
      medicationName: String(facts.medicationName),
      dosage: String(facts.dosage),
      reason,
      auditId: c.auditId,
      suggestedAction: "refill_suggestion",
      idemKey: key,
    };

    return this.runTool(c, tool, key, payload);
  }

  // --- Run Tool Helper ---
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

export function registerPharmacyWorkflow(deps: PharmacyWorkflowDeps): PharmacyWorkflow {
  const workflow = new PharmacyWorkflow(deps);
  workflow.startPeriodic();
  return workflow;
}
