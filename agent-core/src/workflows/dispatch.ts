// Dispatch workflow: SOS / emergency incident -> automated ambulance dispatch.
// Jev decides, Gemini only builds fact-only state, code enforces safety via Gate + kill switch + audit.
import type { Audit, AuditOutcome } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { Gate } from "../control/gate.js";
import type { Event } from "../events/events.js";
import { choice, noul, type Answer, type Decider } from "../judge/jev.js";
import { ProviderError, type LlmProvider } from "../llm/provider.js";
import { signAgentToken } from "../config.js";
import {
  DispatchClient,
  DISPATCH_ASSIGN_TOOL,
  type Ambulance,
  type Hospital,
  type Incident,
} from "../tools/dispatch.js";

export type Outcome = AuditOutcome;

export const DISPATCH_FACTS_PROMPT = [
  "You turn emergency incident details and available response units into a fact-only state for a dispatch decision model.",
  "Return JSON only: {\"incidentId\": string, \"severity\": string, \"candidateUnits\": [{\"id\": string, \"callSign\": string, \"type\": string, \"distanceKm\": number, \"etaMinutes\": number}]}.",
  "Facts only: copy what the record says, add no interpretation, diagnosis or medical advice.",
  "Never choose, suggest or assign a unit.",
].join("\n");

export interface DispatchWorkflowDeps {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  dispatch: Pick<DispatchClient, "call" | "getIncident" | "getAvailableAmbulances" | "getScoredHospitals" | "getRecommendations">;
  health?: { isUp(name: string): boolean };
}

export interface DispatchWorkflowEvent {
  id: string;
  type: string;
  incidentId?: string;
  doc?: any;
  at?: string;
}

type Ctx = { event: DispatchWorkflowEvent; auditId: string; keep: boolean };
type Result = { outcome: Outcome; reason?: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function buildDispatchQuestions(units: { id: string; callSign?: string; type?: string; distanceKm?: number; etaMinutes?: number }[]) {
  const criteria: Record<string, string> = {};
  for (const u of units) {
    const distStr = u.distanceKm !== undefined ? `${u.distanceKm}km` : "unknown distance";
    const etaStr = u.etaMinutes !== undefined ? `${u.etaMinutes}min` : "unknown ETA";
    const typeStr = u.type || "standard";
    criteria[u.id] = `Ambulance ${u.callSign || u.id} (${typeStr}, distance: ${distStr}, ETA: ${etaStr})`;
  }
  return {
    unit: choice("Which available ambulance unit should be dispatched to this emergency incident?", criteria),
    act_now: noul("Dispatching this chosen ambulance unit now is safe and correct for this emergency incident"),
  };
}

export class DispatchWorkflow {
  private readonly d: DispatchWorkflowDeps;
  /** Idempotency keys whose write is in progress in this process. */
  private readonly inFlight = new Set<string>();
  private retrying?: Promise<number>;

  constructor(deps: DispatchWorkflowDeps) {
    this.d = deps;
  }

  async handle(event: DispatchWorkflowEvent): Promise<Outcome> {
    return (await this.process(event)).outcome;
  }

  /**
   * Re-handle queued events and ack every one not kept. Returns how many were handled.
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
      const { keep } = await this.process(e as unknown as DispatchWorkflowEvent);
      if (!keep) await this.d.state.ack(e.id);
    }
    return events.length;
  }

  private async process(event: DispatchWorkflowEvent): Promise<{ outcome: Outcome; keep: boolean }> {
    const c: Ctx = {
      event,
      auditId: await this.d.audit.start({
        id: event.id,
        type: event.type,
        doc: event.doc,
        at: event.at || new Date().toISOString(),
      } as Event),
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
    await this.d.state.enqueue({
      id: c.event.id,
      type: c.event.type,
      doc: c.event.doc,
      at: c.event.at || new Date().toISOString(),
    } as Event);
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

    // 1. Check kill switch
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    // Health check if available
    if (this.d.health && !this.d.health.isUp("dispatch")) {
      // If dispatch is explicitly tracked and down
      if (!this.d.health.isUp("dispatch")) {
        return { outcome: "pending", reason: "dispatch_unavailable" };
      }
    }

    const incidentId = event.incidentId || event.doc?.id || (event.id.startsWith("PAT-") || event.id.startsWith("INC-") ? event.id : undefined);
    if (!incidentId) {
      return { outcome: "skipped", reason: "missing_incident_id" };
    }

    // 2. Fetch authoritative incident state
    let incident: Incident;
    if (event.doc?.status && event.doc?.location_lat !== undefined) {
      incident = event.doc as Incident;
    } else {
      const incRes = await this.d.dispatch.getIncident(incidentId);
      if (!incRes.ok) {
        if (incRes.status === 404) return { outcome: "skipped", reason: "incident_not_found" };
        return { outcome: "pending", reason: "dispatch_unavailable" };
      }
      incident = incRes.data;
    }

    // Hard rule: only PENDING incidents
    if (incident.status !== "PENDING") {
      await this.step(c, "validation", { incidentId: incident.id, status: incident.status, reason: "not_pending" });
      return { outcome: "skipped", reason: "not_pending" };
    }

    // Hard rule: never reassign
    if (incident.assigned_ambulance_id) {
      await this.step(c, "validation", { incidentId: incident.id, assigned_ambulance_id: incident.assigned_ambulance_id, reason: "already_assigned" });
      return { outcome: "blocked", reason: "never_reassign" };
    }

    // 3. Fetch available units
    const ambResult = await this.d.dispatch.getAvailableAmbulances({
      lat: incident.location_lat,
      lng: incident.location_lng,
    });
    if (!ambResult.ok) {
      await this.step(c, "units", { error: ambResult.error });
      return { outcome: "pending", reason: "dispatch_unavailable" };
    }

    const availableAmbulances = ambResult.data.ambulances || [];
    if (availableAmbulances.length === 0) {
      await this.step(c, "units", { count: 0, reason: "no_available_ambulances" });
      // Leave for human dispatcher and audit
      return { outcome: "review", reason: "no_available_ambulances" };
    }

    // Normalise candidate units with distance and ETA
    const candidateUnits = availableAmbulances.map((u) => {
      const dist = u.distance !== undefined ? Math.round(Number(u.distance) * 10) / 10 : 5.0;
      const eta = Math.max(1, Math.round(dist * 1.5));
      const unitType = u.type || u.unit_type || "ALS";
      return {
        id: u.id,
        callSign: u.call_sign || u.callSign || u.id,
        type: unitType,
        distanceKm: dist,
        etaMinutes: eta,
      };
    });

    // 4. Gemini builds fact-only state
    const gemini = await this.llmJson(
      DISPATCH_FACTS_PROMPT,
      JSON.stringify({
        incident: {
          id: incident.id,
          severity: incident.severity || "HIGH",
          incidentType: incident.incident_type || "Medical emergency",
          location: { lat: incident.location_lat, lng: incident.location_lng },
        },
        availableAmbulances: candidateUnits,
      }),
      isObject,
    );

    if (!gemini.ok) {
      await this.step(c, "state", { error: gemini.error });
      return { outcome: "pending", reason: "llm_unavailable" };
    }

    // Code-owned facts override any LLM field
    const facts = {
      ...gemini.value,
      incidentId: incident.id,
      status: incident.status,
      candidateUnits,
    };
    await this.step(c, "state", facts);

    // 5. Jev makes the decision
    const questions = buildDispatchQuestions(candidateUnits);
    const decision = await this.d.jev.decide(facts, questions, "dispatch");
    const { answers } = decision;
    const chosenUnitId = answers.unit?.choice ?? "";
    const unitProb = answers.unit?.probabilities?.[chosenUnitId] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;

    await this.step(c, "jev", { answers, fallback: decision.fallback, cost: decision.cost, error: decision.error });

    if (!candidateUnits.some((u) => u.id === chosenUnitId)) {
      return { outcome: "failed", reason: "unknown_unit_chosen" };
    }

    // 6. Gate check
    const key = `dispatch:${incident.id}`;
    const stopped = await this.d.state.isStopped();
    const done = await this.d.state.isDone(key);
    const verdict = this.d.gate.check({
      group: "dispatch",
      action: "assign",
      actionProb: unitProb,
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
      // Suggest level (human confirms) or threshold < 0.9 -> leave for human dispatcher and audit
      await this.step(c, "review", {
        incidentId: incident.id,
        chosenUnitId,
        unitProb,
        actNow,
        reason: verdict.reason,
      });
      return { outcome: "review", reason: verdict.reason };
    }

    // 7. Execute assignment holding key
    return this.withKey(c, key, () => this.execute(c, incident, chosenUnitId, key, answers, facts));
  }

  private async execute(
    c: Ctx,
    incident: Incident,
    chosenUnitId: string,
    key: string,
    answers: Record<string, Answer>,
    facts: object,
  ): Promise<Result> {
    // Re-check idempotency & kill switch inside key lock
    if (await this.d.state.isDone(key)) return { outcome: "blocked", reason: "duplicate" };
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }

    // Always refetch the incident right before the write and require status PENDING and unassigned
    const refetched = await this.d.dispatch.getIncident(incident.id);
    if (!refetched.ok) {
      return refetched.status === 404
        ? { outcome: "skipped", reason: "incident_not_found" }
        : { outcome: "pending", reason: "dispatch_unavailable" };
    }
    const currentIncident = refetched.data;
    if (currentIncident.status !== "PENDING") {
      await this.step(c, "validation", { incidentId: currentIncident.id, status: currentIncident.status, reason: "not_pending" });
      return { outcome: "blocked", reason: "not_pending" };
    }
    if (currentIncident.assigned_ambulance_id) {
      await this.step(c, "validation", { incidentId: currentIncident.id, assigned_ambulance_id: currentIncident.assigned_ambulance_id, reason: "already_assigned" });
      return { outcome: "blocked", reason: "never_reassign" };
    }

    // Resolve hospital
    let hospitalId = currentIncident.assigned_hospital_id;
    if (!hospitalId) {
      const hospResult = await this.d.dispatch.getScoredHospitals(currentIncident.id);
      if (hospResult.ok && hospResult.data.hospitals?.length) {
        hospitalId = hospResult.data.hospitals[0].id;
      } else {
        const recResult = await this.d.dispatch.getRecommendations(currentIncident.id);
        if (recResult.ok && recResult.data.hospitals?.length) {
          hospitalId = recResult.data.hospitals[0].id;
        }
      }
    }

    if (!hospitalId) {
      await this.step(c, "hospital", { reason: "no_available_hospitals" });
      return { outcome: "review", reason: "no_available_hospitals" };
    }

    // Recheck the kill switch immediately before DISPATCH_ASSIGN_TOOL.run (after hospital lookups)
    if (await this.d.state.isStopped()) {
      await this.enqueue(c);
      return { outcome: "blocked", reason: "stopped" };
    }
    if (await this.d.state.isDone(key)) {
      return { outcome: "blocked", reason: "duplicate" };
    }

    const unitProb = answers.unit?.probabilities?.[chosenUnitId] ?? 0;
    const actNow = answers.act_now?.noul ?? 0;

    const assignArgs = {
      incident_id: currentIncident.id,
      ambulance_id: chosenUnitId,
      hospital_id: hospitalId,
      notes: `Agent dispatch: unit ${chosenUnitId} (prob: ${unitProb.toFixed(2)}, act_now: ${actNow.toFixed(2)}, audit: ${c.auditId})`,
    };

    const result = await DISPATCH_ASSIGN_TOOL.run(assignArgs, this.d.dispatch);
    await this.step(c, "tool", { tool: DISPATCH_ASSIGN_TOOL.name, key, args: assignArgs, result });

    if (!result.ok) {
      if (result.status === 409) return { outcome: "blocked", reason: "conflict" };
      const clientError = result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;
      return clientError
        ? { outcome: "failed", reason: "dispatch_error" }
        : { outcome: "pending", reason: "dispatch_unavailable" };
    }

    this.d.gate.record("dispatch");
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

export function createDispatchWorkflow(deps: {
  jev: Decider;
  llm: LlmProvider;
  audit: Audit;
  state: AgentState;
  gate: Gate;
  health?: { isUp(name: string): boolean };
  agentJwtSecret?: string;
  dispatchUrl?: string;
  dispatchClient?: DispatchClient;
}): DispatchWorkflow {
  const dispatch = deps.dispatchClient ?? new DispatchClient({
    baseUrl: deps.dispatchUrl || process.env.DISPATCH_URL || "http://dispatch-api:3001",
    token: deps.agentJwtSecret ? () => signAgentToken(deps.agentJwtSecret!) : undefined,
  });
  return new DispatchWorkflow({
    jev: deps.jev,
    llm: deps.llm,
    audit: deps.audit,
    state: deps.state,
    gate: deps.gate,
    dispatch,
    health: deps.health,
  });
}
