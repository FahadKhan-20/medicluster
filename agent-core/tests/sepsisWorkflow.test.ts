import { describe, it, expect } from "vitest";
import { SepsisWorkflow, SEPSIS_JEV_QUESTIONS, SEPSIS_STATE_PROMPT } from "../src/workflows/sepsis.js";
import { formatReadingsToHourlySequence, sepsisScoreTool, fetchPatientReadings } from "../src/tools/sepsis.js";
import { FakeJev, type Answer, type Decider, type Question } from "../src/judge/jev.js";
import { FakeLlm } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import type { Event } from "../src/events/events.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = {
  threshold: 0.9,
  groups: { imaging: "auto", alerts: "auto", sepsis: "auto" },
  rateLimitPerMinute: 30,
} as const;

function jevRules(action: string, prob: number, urgency = 2, actNow = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const others = ["alert", "request_review", "ignore"].filter((a) => a !== action);
      const rest = (1 - prob) / others.length;
      return {
        type: "choice",
        choice: action,
        probabilities: { [action]: prob, ...Object.fromEntries(others.map((o) => [o, rest])) },
        confidence: prob,
      };
    }
    if (name === "urgency") return { type: "score", score: urgency, probabilities: { "0": 0, "1": 0, [String(urgency)]: 1 } };
    return { type: "noul", noul: actNow };
  };
}

function setup(o: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  up?: Record<string, boolean>;
  readings?: any[];
  scoreResult?: any;
  backendFails?: boolean;
  policy?: any;
} = {}) {
  const { rpc, db } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const gate = new Gate({ current: () => o.policy ?? POLICY } as unknown as PolicyStore);
  const calls: { method: string; path: string; body?: any }[] = [];

  const defaultReadings = o.readings ?? [
    {
      patientId: "patient_1",
      heart_rate: 115,
      respiratory_rate: 26,
      systolic_bp: 88,
      diastolic_bp: 52,
      temperature: 38.8,
      spo2: 91,
      takenAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    },
    {
      patientId: "patient_1",
      heart_rate: 122,
      respiratory_rate: 28,
      systolic_bp: 84,
      diastolic_bp: 50,
      temperature: 39.1,
      spo2: 90,
      takenAt: new Date().toISOString(),
    },
  ];

  const defaultScore = o.scoreResult ?? {
    risk: 0.88,
    band: "high",
    top_factors: ["Severe tachycardia (HR 122 bpm)", "Severe tachypnea (Resp 28/min)", "Hypotension (MAP 61 mmHg)"],
    model: "sepsis2019-hgb-v1",
  };

  const backend = {
    async call(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (o.backendFails) return { ok: false as const, status: 500, error: "Server error", retryable: true as const };
      if (path.startsWith("/api/ml/readings/")) {
        return { ok: true as const, status: 200, data: defaultReadings };
      }
      if (path === "/api/ml/sepsis/score") {
        return { ok: true as const, status: 200, data: defaultScore };
      }
      if (path === "/api/alerts/agent") {
        return { ok: true as const, status: 201, data: { id: "alert_123" } };
      }
      return { ok: true as const, status: 200, data: {} };
    },
  };

  const health = { isUp: (n: string) => o.up?.[n] ?? true };
  const jev = o.jev ?? new FakeJev(jevRules("alert", 0.95));
  const llm = new FakeLlm(
    o.llm ??
      ((system, user) => {
        if (system === SEPSIS_STATE_PROMPT) {
          return {
            patientId: "patient_1",
            risk: 0.88,
            band: "high",
            top_factors: ["Severe tachycardia", "Hypotension"],
            latest_vitals: { HR: 122, Resp: 28, MAP: 61 },
          };
        }
        return {
          title: "High Sepsis Risk Score (0.88)",
          summary: "Patient heart rate 122 bpm, respiratory rate 28/min, MAP 61 mmHg.",
        };
      }),
  );

  const workflow = new SepsisWorkflow({ jev, llm, audit, state, gate, backend, health });
  const audits = () => [...(db.get("agent_audit")?.values() ?? [])];
  return { workflow, calls, state, audit, audits, jev, llm };
}

const readingEvent = (doc: any = { patientId: "patient_1", _id: "r1", value: 122, type: "hr" }): Event => ({
  id: `reading:${doc._id ?? "1"}`,
  type: "scan.uploaded", // standard Event interface
  mediaId: doc.patientId,
  doc,
  at: new Date().toISOString(),
});

describe("Sepsis Tools & Helpers", () => {
  it("formatReadingsToHourlySequence groups readings into 12-hour hourly buckets", () => {
    const now = new Date();
    const tMinus2h = new Date(now.getTime() - 2 * 3600 * 1000);
    const tMinus1h = new Date(now.getTime() - 1 * 3600 * 1000);

    const readings = [
      { type: "bp", value: 130, diastolic: 85, takenAt: tMinus2h.toISOString() },
      { type: "glucose", value: 110, takenAt: tMinus2h.toISOString() },
      { heart_rate: 105, respiratory_rate: 22, takenAt: tMinus1h.toISOString() },
    ];

    const sequence = formatReadingsToHourlySequence(readings, now, 12);
    expect(sequence.length).toBe(2);
    expect(sequence[0].SBP).toBe(130);
    expect(sequence[0].DBP).toBe(85);
    expect(sequence[0].MAP).toBeCloseTo(85 + (130 - 85) / 3);
    expect(sequence[0].Glucose).toBe(110);
    expect(sequence[1].HR).toBe(105);
    expect(sequence[1].Resp).toBe(22);
  });

  it("sepsisScoreTool validates non-empty hours", async () => {
    const backend = { call: async () => ({ ok: true as const, status: 200, data: {} }) };
    const err = await sepsisScoreTool.run({ hours: [] }, backend as any);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("hours must be a non-empty array");
  });
});

describe("SepsisWorkflow", () => {
  it("elevated sepsis risk at Jev prob 0.95 executes alert with code-owned CRITICAL severity", async () => {
    const t = setup();
    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("executed");

    const alertCalls = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alertCalls).toHaveLength(1);
    const alertBody = alertCalls[0].body;

    expect(alertBody.patient_id).toBe("patient_1");
    expect(alertBody.severity).toBe("CRITICAL");
    expect(alertBody.title).toContain("High Sepsis Risk Score");
    expect(alertBody.summary).toContain("Patient heart rate 122");
    expect(alertBody.audit_id).toBeTruthy();

    const [auditLog] = t.audits();
    expect(auditLog.outcome).toBe("executed");
    expect(auditLog.steps.some((s: any) => s.kind === "sepsis_score")).toBe(true);
  });

  it("low risk assessment where Jev decides ignore -> outcome skipped", async () => {
    const lowScore = {
      risk: 0.12,
      band: "low",
      top_factors: ["Vitals within baseline thresholds"],
      model: "sepsis2019-hgb-v1",
    };
    const t = setup({
      scoreResult: lowScore,
      jev: new FakeJev(jevRules("ignore", 0.98, 0, 0.98)),
    });

    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("skipped");

    const alertCalls = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alertCalls).toHaveLength(0);
  });

  it("uncertain or borderline case where Jev decides request_review -> outcome review", async () => {
    const medScore = {
      risk: 0.48,
      band: "medium",
      top_factors: ["Borderline tachycardia (HR 98)"],
      model: "sepsis2019-hgb-v1",
    };
    const t = setup({
      scoreResult: medScore,
      jev: new FakeJev(jevRules("request_review", 0.95, 1, 0.95)),
    });

    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("review");

    const alertCalls = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alertCalls).toHaveLength(0);
  });

  it("kill switch blocks execution and preserves safety", async () => {
    const t = setup();
    await t.state.setStopped(true);

    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("blocked");

    const alertCalls = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alertCalls).toHaveLength(0);
  });

  it("duplicate reading is blocked by idempotency", async () => {
    const t = setup();
    const event = readingEvent({ patientId: "patient_1", _id: "r1", value: 120 });

    const first = await t.workflow.handle(event);
    expect(first).toBe("executed");

    const second = await t.workflow.handle(event);
    expect(second).toBe("blocked");
  });

  it("health check pending when downstream service is down", async () => {
    const t = setup({ up: { backend: true, ml: false } });
    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("pending");
  });

  it("event without patientId is skipped", async () => {
    const t = setup();
    const outcome = await t.workflow.handle({
      id: "ev_no_patient",
      type: "scan.uploaded",
      at: new Date().toISOString(),
      doc: {},
    });
    expect(outcome).toBe("skipped");
  });
});
