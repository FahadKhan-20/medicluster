import { describe, it, expect, vi } from "vitest";
import {
  DispatchWorkflow,
  DISPATCH_FACTS_PROMPT,
  type DispatchWorkflowEvent,
} from "../src/workflows/dispatch.js";
import { FakeJev, fallbackAnswer, type Answer, type Decider, type Question } from "../src/judge/jev.js";
import { FakeLlm, ProviderError } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const DEFAULT_POLICY = {
  threshold: 0.9,
  groups: { dispatch: "suggest" as const },
  rateLimitPerMinute: 30,
};

const AUTO_POLICY = {
  threshold: 0.9,
  groups: { dispatch: "auto" as const },
  rateLimitPerMinute: 30,
};

const SAMPLE_INCIDENT = {
  id: "INC-101",
  status: "PENDING",
  incident_type: "Cardiac arrest",
  severity: "CRITICAL",
  location_lat: 12.9716,
  location_lng: 77.5946,
  location_address: "Cubbon Park, Bengaluru",
  is_sos: true,
  assigned_ambulance_id: null,
  assigned_hospital_id: null,
};

const SAMPLE_AMBULANCES = [
  { id: "AMB-01", call_sign: "ALPHA-1", type: "ALS", latitude: 12.975, longitude: 77.598, status: "AVAILABLE", distance: 1.2 },
  { id: "AMB-02", call_sign: "BRAVO-2", type: "BLS", latitude: 12.985, longitude: 77.605, status: "AVAILABLE", distance: 3.5 },
];

const SAMPLE_HOSPITALS = [
  { id: "HOSP-01", name: "City General", latitude: 12.98, longitude: 77.6, available_beds: 5, score: 98 },
];

function jevDispatchRules(unitChoice: string, unitProb: number, actNow = 0.95) {
  return (name: string, q: Question): Answer => {
    if (name === "unit") {
      const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
      const others = keys.filter((k) => k !== unitChoice);
      const rest = others.length ? (1 - unitProb) / others.length : 0;
      return {
        type: "choice",
        choice: unitChoice,
        probabilities: {
          [unitChoice]: unitProb,
          ...Object.fromEntries(others.map((o) => [o, rest])),
        },
        confidence: unitProb,
      };
    }
    return { type: "noul", noul: actNow };
  };
}

function setup(o: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  policy?: any;
  incident?: any;
  ambulances?: any[];
  hospitals?: any[];
  dispatchCall?: (method: string, path: string, body?: any) => Promise<any>;
  assignStatus?: number;
} = {}) {
  const { rpc } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const policyObj = o.policy ?? AUTO_POLICY;
  const gate = new Gate({ current: () => policyObj } as unknown as PolicyStore);

  const calls: { method: string; path: string; body?: any }[] = [];
  const incident = o.incident !== undefined ? o.incident : SAMPLE_INCIDENT;
  const ambulances = o.ambulances !== undefined ? o.ambulances : SAMPLE_AMBULANCES;
  const hospitals = o.hospitals !== undefined ? o.hospitals : SAMPLE_HOSPITALS;

  const dispatch = {
    async call(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (o.dispatchCall) return o.dispatchCall(method, path, body);
      if (path.startsWith("/api/assignments") && method === "POST") {
        if (o.assignStatus && o.assignStatus !== 201) {
          return { ok: false as const, status: o.assignStatus, error: `HTTP ${o.assignStatus}`, retryable: false as const };
        }
        return { ok: true as const, status: 201, data: { ...(body as object), status: "ASSIGNED" } };
      }
      return { ok: true as const, status: 200, data: {} };
    },
    async getIncident(id: string) {
      calls.push({ method: "GET", path: `/api/incidents/${id}` });
      if (incident && incident.id === id) {
        return { ok: true as const, status: 200, data: incident };
      }
      return { ok: false as const, status: 404, error: "Incident not found", retryable: false as const };
    },
    async getAvailableAmbulances() {
      calls.push({ method: "GET", path: "/api/ambulances/available" });
      return { ok: true as const, status: 200, data: { ambulances } };
    },
    async getScoredHospitals(id: string) {
      calls.push({ method: "GET", path: `/api/hospitals/scored/${id}` });
      return { ok: true as const, status: 200, data: { hospitals } };
    },
    async getRecommendations(id: string) {
      calls.push({ method: "GET", path: `/api/assignments/recommendations/${id}` });
      return { ok: true as const, status: 200, data: { ambulances, hospitals } };
    },
  };

  const jev = o.jev ?? new FakeJev(jevDispatchRules("AMB-01", 0.95, 0.95));
  const llm = new FakeLlm(
    o.llm ??
      ((system, user) => {
        if (system === DISPATCH_FACTS_PROMPT) {
          const parsed = JSON.parse(user);
          return {
            incidentId: parsed.incident?.id || "INC-101",
            severity: parsed.incident?.severity || "HIGH",
            candidateUnits: parsed.availableAmbulances || [],
          };
        }
        return {};
      }),
  );

  const workflow = new DispatchWorkflow({ jev, llm, audit, state, gate, dispatch });
  return { workflow, dispatch, audit, state, gate, calls, store };
}

describe("DispatchWorkflow", () => {
  it("executes automated dispatch when incident is PENDING, confidence >= 0.9 and policy is auto", async () => {
    const { workflow, calls, state } = setup({ policy: AUTO_POLICY });
    const event: DispatchWorkflowEvent = {
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    };

    const outcome = await workflow.handle(event);
    expect(outcome).toBe("executed");

    const assignCall = calls.find((c) => c.method === "POST" && c.path === "/api/assignments");
    expect(assignCall).toBeDefined();
    expect(assignCall?.body).toMatchObject({
      incidentId: "INC-101",
      ambulanceId: "AMB-01",
      hospitalId: "HOSP-01",
    });

    const isDone = await state.isDone("dispatch:INC-101");
    expect(isDone).toBe(true);
  });

  it("leaves for human dispatcher and audits review under default policy 'dispatch: suggest'", async () => {
    const { workflow, calls } = setup({ policy: DEFAULT_POLICY });
    const event: DispatchWorkflowEvent = {
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    };

    const outcome = await workflow.handle(event);
    expect(outcome).toBe("review");

    // Must NOT call assignment write endpoint when policy is suggest
    const assignCall = calls.find((c) => c.method === "POST" && c.path === "/api/assignments");
    expect(assignCall).toBeUndefined();
  });

  it("leaves for human dispatcher and audits review when confidence is below 0.9 threshold", async () => {
    const lowConfidenceJev = new FakeJev(jevDispatchRules("AMB-01", 0.82, 0.95));
    const { workflow, calls } = setup({ policy: AUTO_POLICY, jev: lowConfidenceJev });
    const event: DispatchWorkflowEvent = {
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    };

    const outcome = await workflow.handle(event);
    expect(outcome).toBe("review");

    const assignCall = calls.find((c) => c.method === "POST" && c.path === "/api/assignments");
    expect(assignCall).toBeUndefined();
  });

  it("leaves for human dispatcher when act_now is below threshold", async () => {
    const lowActNowJev = new FakeJev(jevDispatchRules("AMB-01", 0.95, 0.75));
    const { workflow, calls } = setup({ policy: AUTO_POLICY, jev: lowActNowJev });
    const event: DispatchWorkflowEvent = {
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    };

    const outcome = await workflow.handle(event);
    expect(outcome).toBe("review");

    const assignCall = calls.find((c) => c.method === "POST" && c.path === "/api/assignments");
    expect(assignCall).toBeUndefined();
  });

  it("skips non-PENDING incidents (hard rule: only PENDING)", async () => {
    for (const status of ["ASSIGNED", "CANCELLED", "RESOLVED"]) {
      const { workflow, calls } = setup({
        policy: AUTO_POLICY,
        incident: { ...SAMPLE_INCIDENT, status },
      });

      const outcome = await workflow.handle({
        id: "INC-101",
        type: "incident.pending",
        incidentId: "INC-101",
        doc: { ...SAMPLE_INCIDENT, status },
      });
      expect(outcome).toBe("skipped");
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("blocks reassignment if an ambulance is already assigned (hard rule: never reassign)", async () => {
    const { workflow, calls } = setup({
      policy: AUTO_POLICY,
      incident: { ...SAMPLE_INCIDENT, status: "PENDING", assigned_ambulance_id: "AMB-99" },
    });

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: { ...SAMPLE_INCIDENT, assigned_ambulance_id: "AMB-99" },
    });
    expect(outcome).toBe("blocked");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reviews and audits when no ambulances are available", async () => {
    const { workflow, calls } = setup({
      policy: AUTO_POLICY,
      ambulances: [],
    });

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("review");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("blocks and enqueues event when kill switch is active", async () => {
    const { workflow, state } = setup({ policy: AUTO_POLICY });
    await state.setStopped(true);

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("blocked");

    const queued = await state.drain();
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe("INC-101");
  });

  it("blocks duplicate executions with the same key", async () => {
    const { workflow, state } = setup({ policy: AUTO_POLICY });
    await state.markDone("dispatch:INC-101");

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("blocked");
  });

  it("yields review on Jev fallback", async () => {
    const fallbackJev = {
      async decide(_facts: unknown, questions: Record<string, Question>) {
        return {
          answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, fallbackAnswer(q)])),
          cost: 0,
          fallback: true,
        };
      },
    };

    const { workflow, calls } = setup({ policy: AUTO_POLICY, jev: fallbackJev });
    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("review");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("handles Gemini LLM provider failure as pending for retry", async () => {
    const failingLlm = () => {
      throw new ProviderError("model quota exceeded");
    };
    const { workflow } = setup({ policy: AUTO_POLICY, llm: failingLlm });

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("pending");
  });

  it("handles 409 conflict during assignment as blocked", async () => {
    const { workflow } = setup({ policy: AUTO_POLICY, assignStatus: 409 });
    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("blocked");
  });

  it("handles 500 server error during assignment as pending", async () => {
    const { workflow } = setup({ policy: AUTO_POLICY, assignStatus: 500 });
    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("pending");
  });

  it("enforces rate limits per minute", async () => {
    const rateLimitedPolicy = {
      threshold: 0.9,
      groups: { dispatch: "auto" as const },
      rateLimitPerMinute: 1,
    };
    const { workflow, gate } = setup({ policy: rateLimitedPolicy });

    gate.record("dispatch"); // Use up the 1 slot

    const outcome = await workflow.handle({
      id: "INC-101",
      type: "incident.pending",
      incidentId: "INC-101",
      doc: SAMPLE_INCIDENT,
    });
    expect(outcome).toBe("blocked");
  });

  it("retryPending drains and re-handles queued events", async () => {
    const { workflow, state } = setup({ policy: AUTO_POLICY });

    await state.enqueue({
      id: "INC-QUEUED",
      type: "incident.pending",
      doc: { ...SAMPLE_INCIDENT, id: "INC-QUEUED" },
      at: new Date().toISOString(),
    });

    const count = await workflow.retryPending();
    expect(count).toBe(1);

    const isDone = await state.isDone("dispatch:INC-QUEUED");
    expect(isDone).toBe(true);
  });
});
