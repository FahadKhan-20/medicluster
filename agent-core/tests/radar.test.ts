import { describe, it, expect } from "vitest";
import {
  RadarWorkflow,
  RADAR_ARGS_PROMPT,
  RADAR_JEV_QUESTIONS,
  RADAR_STATE_PROMPT,
  readingRowToEvent,
  type RadarEvent,
} from "../src/workflows/radar.js";
import { radarForecastTool, fetchRadarForecast } from "../src/tools/radar.js";
import { FakeJev, type Answer, type Decider, type Question } from "../src/judge/jev.js";
import { FakeLlm } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = { threshold: 0.9, groups: { radar: "auto", alerts: "auto" }, rateLimitPerMinute: 30 } as const;

const SESSION_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const FORECAST_DATA = {
  id: SESSION_ID,
  patientId: "patient-123",
  source: "manual",
  scenario: null,
  readings: [
    { timestamp: "2026-11-12T10:00:00Z", heart_rate: 115, spo2: 93, systolic_bp: 95, diastolic_bp: 60, respiratory_rate: 22, temperature: 38.5 },
  ],
  cursor: 12,
  totalReadings: 12,
  score: {
    value: 8,
    tier: "high",
    drivers: [{ name: "heart_rate", value: 115, points: 2, reason: "Reference physiological scoring band" }],
    assumptions: ["NEWS2 adult reference"],
  },
  forecast: {
    model: "amazon/chronos-2",
    steps: 6,
    intervalMinutes: 5,
    series: {
      heart_rate: { lower: [110, 112], median: [120, 125], upper: [130, 135] },
    },
    warnings: ["Projected reference-threshold crossing: heart_rate median 125.0 at step 2"],
  },
  createdAt: "2026-11-12T09:00:00Z",
};

const READING_DOC = {
  _id: "read-1",
  patientId: "patient-123",
  sessionId: SESSION_ID,
  type: "bp",
  value: 95,
  diastolic: 60,
  takenAt: "2026-11-12T10:00:00Z",
};

const readingEvent = (doc: any = READING_DOC): RadarEvent => ({
  id: `${doc._id || "r1"}:${doc.takenAt || "2026-11-12T10:00:00Z"}`,
  type: "reading.created",
  readingId: doc._id || "r1",
  patientId: doc.patientId,
  sessionId: doc.sessionId,
  doc,
  at: "2026-11-12T10:00:01.000Z",
});

const STATE_SUMMARY = {
  patientId: "patient-123",
  score: 8,
  tier: "high",
  vitals: { heart_rate: 115, spo2: 93 },
  forecastSummary: "Worsening trend in heart rate crossing threshold",
  warnings: ["Projected threshold crossing"],
};

function jevRules(action: string, prob: number, risk = 2, actNow = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const others = ["alert", "review", "ignore"].filter((a) => a !== action);
      const rest = (1 - prob) / others.length;
      return {
        type: "choice",
        choice: action,
        probabilities: { [action]: prob, ...Object.fromEntries(others.map((o) => [o, rest])) },
        confidence: prob,
      };
    }
    if (name === "risk") {
      return {
        type: "score",
        score: risk,
        probabilities: { "0": risk === 0 ? 1 : 0, "1": risk === 1 ? 1 : 0, "2": risk === 2 ? 1 : 0 },
      };
    }
    return { type: "noul", noul: actNow };
  };
}

function argsFor(user: string) {
  const parsed = JSON.parse(user);
  if (parsed.action === "alert") {
    return {
      tool: "alerts.create",
      arguments: {
        title: "Deterioration Radar: High Risk Detected",
        summary: "NEWS2 score 8 with projected heart rate spike",
      },
    };
  }
  return { tool: "alerts.create", arguments: { title: "Review", summary: "Review needed" } };
}

function setup(o: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  up?: Record<string, boolean>;
  backendFails?: boolean;
  forecastData?: any;
  backendCall?: (method: string, path: string, body?: any) => Promise<any>;
  policy?: any;
} = {}) {
  const { rpc, db } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const gate = new Gate({ current: () => o.policy ?? POLICY } as unknown as PolicyStore);
  const calls: { method: string; path: string; body?: any }[] = [];
  const backend = {
    async call(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (o.backendCall) return o.backendCall(method, path, body);
      if (o.backendFails) return { ok: false as const, status: 500, error: "HTTP 500", retryable: true as const };
      if (path.includes("/forecast")) {
        return { ok: true as const, status: 200, data: o.forecastData ?? FORECAST_DATA };
      }
      return { ok: true as const, status: 200, data: { _id: "alert-1" } };
    },
  };
  const health = { isUp: (n: string) => o.up?.[n] ?? true };
  const jev = o.jev ?? new FakeJev(jevRules("alert", 0.95, 2));
  const llm = new FakeLlm(
    o.llm ??
      ((system, user) => {
        if (system === RADAR_STATE_PROMPT) return STATE_SUMMARY;
        return argsFor(user);
      }),
  );
  const workflow = new RadarWorkflow({ jev, llm, audit, state, gate, backend, health });
  const audits = () => [...(db.get("agent_audit")?.values() ?? [])];
  return { workflow, calls, state, audit, audits, jev, llm, backend };
}

describe("RADAR_JEV_QUESTIONS", () => {
  it("has action, risk and act_now", () => {
    expect(RADAR_JEV_QUESTIONS.action.type).toBe("choice");
    expect(Object.keys(RADAR_JEV_QUESTIONS.action.criteria as object)).toEqual(["alert", "review", "ignore"]);
    expect(RADAR_JEV_QUESTIONS.risk).toMatchObject({ type: "score", criteria: ["routine", "urgent", "critical"] });
    expect(RADAR_JEV_QUESTIONS.act_now).toEqual({
      type: "noul",
      instructions: "Acting now on the chosen action is safe and correct for this patient",
    });
  });
});

describe("radarForecastTool", () => {
  it("validates arguments and calls the backend route", async () => {
    const calls: any[] = [];
    const client = {
      call: async (m: string, p: string, b?: any) => {
        calls.push({ m, p, b });
        return { ok: true as const, status: 200, data: {} };
      },
    };
    const res = await radarForecastTool.run({ sessionId: SESSION_ID }, client as any);
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      m: "POST",
      p: `/api/intelligence/radar/sessions/${SESSION_ID}/forecast`,
      b: { steps: 6 },
    });
  });

  it("fails when sessionId is invalid", async () => {
    const client = { call: async () => ({ ok: true as const, status: 200, data: {} }) };
    const res = await radarForecastTool.run({ sessionId: "" }, client as any);
    expect(res.ok).toBe(false);
  });

  it("fetchRadarForecast helper calls route with steps", async () => {
    const calls: any[] = [];
    const client = {
      call: async (m: string, p: string, b?: any) => {
        calls.push({ m, p, b });
        return { ok: true as const, status: 200, data: {} };
      },
    };
    await fetchRadarForecast(client as any, SESSION_ID, { steps: 12 });
    expect(calls[0].p).toBe(`/api/intelligence/radar/sessions/${SESSION_ID}/forecast`);
    expect(calls[0].b).toEqual({ steps: 12 });
  });
});

describe("RadarWorkflow", () => {
  it("critical deterioration at 0.95 executes alert with CRITICAL severity", async () => {
    const t = setup();
    const outcome = await t.workflow.handle(readingEvent());
    expect(outcome).toBe("executed");

    const forecastCall = t.calls.find((c) => c.path.includes("/forecast"));
    expect(forecastCall).toBeDefined();
    expect(forecastCall?.path).toBe(`/api/intelligence/radar/sessions/${SESSION_ID}/forecast`);

    const alertCalls = t.calls.filter((c) => c.method === "POST" && c.path === "/api/alerts/agent");
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0].body).toEqual({
      patient_id: "patient-123",
      source_id: SESSION_ID,
      severity: "CRITICAL",
      title: "Deterioration Radar: High Risk Detected",
      summary: "NEWS2 score 8 with projected heart rate spike",
      jev_probabilities: {
        action: { alert: 0.95, review: (1 - 0.95) / 2, ignore: (1 - 0.95) / 2 },
        risk: { "0": 0, "1": 0, "2": 1 },
        act_now: 0.95,
      },
      audit_id: expect.any(String),
    });

    const [a] = t.audits();
    expect(a.steps.map((s: any) => s.kind)).toEqual(expect.arrayContaining(["forecast", "state", "jev", "gate", "args", "tool"]));
    expect(a.outcome).toBe("executed");
    expect(await t.state.isDone(`read-1:2026-11-12T10:00:00Z:alert`)).toBe(true);
  });

  it("maps routine risk to WARNING, urgent to HIGH", async () => {
    for (const [r, sev] of [[0, "WARNING"], [1, "HIGH"]] as const) {
      const t = setup({ jev: new FakeJev(jevRules("alert", 0.95, r)) });
      expect(await t.workflow.handle(readingEvent())).toBe("executed");
      const alert = t.calls.find((c) => c.path === "/api/alerts/agent");
      expect(alert?.body.severity).toBe(sev);
    }
  });

  it("skips non-reading doc (like image files)", async () => {
    const t = setup();
    expect(await t.workflow.handle(readingEvent({ _id: "x", file_type: "image" }))).toBe("skipped");
    expect(t.calls).toHaveLength(0);
  });

  it("jev ignore returns skipped", async () => {
    const t = setup({ jev: new FakeJev(jevRules("ignore", 0.95)) });
    expect(await t.workflow.handle(readingEvent())).toBe("skipped");
    const alerts = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alerts).toHaveLength(0);
  });

  it("jev review returns review outcome", async () => {
    const t = setup({ jev: new FakeJev(jevRules("review", 0.95)) });
    expect(await t.workflow.handle(readingEvent())).toBe("review");
    const alerts = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alerts).toHaveLength(0);
  });

  it("gate blocks execution when policy radar group is off", async () => {
    const t = setup({ policy: { threshold: 0.9, groups: { radar: "off" }, rateLimitPerMinute: 30 } });
    expect(await t.workflow.handle(readingEvent())).toBe("blocked");
    const alerts = t.calls.filter((c) => c.path === "/api/alerts/agent");
    expect(alerts).toHaveLength(0);
  });

  it("low confidence triggers gate review verdict", async () => {
    const t = setup({ jev: new FakeJev(jevRules("alert", 0.7, 2, 0.7)) });
    expect(await t.workflow.handle(readingEvent())).toBe("review");
  });

  it("kill switch blocks execution and enqueues event", async () => {
    const t = setup();
    await t.state.setStopped(true);
    expect(await t.workflow.handle(readingEvent())).toBe("blocked");
    expect((await t.state.drain()).length).toBe(1);
    expect(t.calls).toHaveLength(0);
  });

  it("duplicate reading is blocked by idempotency", async () => {
    const t = setup();
    expect(await t.workflow.handle(readingEvent())).toBe("executed");
    expect(await t.workflow.handle(readingEvent())).toBe("blocked");
  });

  it("service down returns pending status", async () => {
    const t = setup({ up: { intelligence: false } });
    expect(await t.workflow.handle(readingEvent())).toBe("pending");
    expect((await t.state.drain()).length).toBe(1);
  });

  it("backend forecast error 400 results in failed", async () => {
    const t = setup({
      backendCall: async (_m, path) => {
        if (path.includes("/forecast")) return { ok: false, status: 400, error: "bad request", retryable: false };
        return { ok: true, status: 200, data: {} };
      },
    });
    expect(await t.workflow.handle(readingEvent())).toBe("failed");
  });

  it("backend forecast error 500 results in pending", async () => {
    const t = setup({
      backendCall: async (_m, path) => {
        if (path.includes("/forecast")) return { ok: false, status: 503, error: "unavailable", retryable: true };
        return { ok: true, status: 200, data: {} };
      },
    });
    expect(await t.workflow.handle(readingEvent())).toBe("pending");
    expect((await t.state.drain()).length).toBe(1);
  });

  it("retryPending drains queued items when service resumes", async () => {
    const t = setup({ up: { intelligence: false } });
    await t.workflow.handle(readingEvent());
    expect((await t.state.drain()).length).toBe(1);

    (t as any).workflow.d.health.isUp = () => true;
    const handledCount = await t.workflow.retryPending();
    expect(handledCount).toBe(1);
    expect((await t.state.drain()).length).toBe(0);
  });
});

describe("readingRowToEvent", () => {
  it("converts readings collection row to RadarEvent", () => {
    const row = {
      collection: "readings",
      data: {
        _id: "read-99",
        patientId: "patient-1",
        sessionId: "session-1",
        type: "bp",
        value: 120,
        takenAt: "2026-11-12T12:00:00Z",
      },
    };
    const ev = readingRowToEvent(row);
    expect(ev).not.toBeNull();
    expect(ev?.id).toBe("read-99:2026-11-12T12:00:00Z");
    expect(ev?.patientId).toBe("patient-1");
    expect(ev?.sessionId).toBe("session-1");
  });

  it("ignores non-readings collections", () => {
    const row = {
      collection: "users",
      data: { _id: "u1" },
    };
    expect(readingRowToEvent(row)).toBeNull();
  });
});
