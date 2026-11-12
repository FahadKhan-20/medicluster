import { describe, it, expect, vi } from "vitest";
import { EcgWorkflow, type EcgEvent, ECG_JEV_QUESTIONS } from "../src/workflows/ecg.js";
import { ecgAnalyzeTool, validateEcgArgs } from "../src/tools/ecg.js";
import { FakeJev, type Answer, type Question } from "../src/judge/jev.js";
import { FakeLlm } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = {
  threshold: 0.9,
  groups: { imaging: "auto", alerts: "auto", ecg: "auto" },
  rateLimitPerMinute: 30,
} as const;

function createDummySignal(): number[][] {
  return Array.from({ length: 12 }, () => Array.from({ length: 1000 }, () => 0.05));
}

function makeEcgDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "rec_ecg_1",
    patient_id: "pat_99",
    signal: createDummySignal(),
    lead_order: ["I", "II", "III", "AVR", "AVL", "AVF", "V1", "V2", "V3", "V4", "V5", "V6"],
    ...overrides,
  };
}

function makeEvent(doc: any, type: "ecg.uploaded" | "ecg.analyzed" = "ecg.uploaded"): EcgEvent {
  return {
    id: `${doc._id}:${type === "ecg.uploaded" ? "new" : "analyzed"}`,
    type,
    recordId: doc._id,
    patientId: doc.patient_id,
    doc,
    at: "2026-11-13T00:00:00.000Z",
  };
}

function jevAnswers(action: "alert" | "review" | "ignore", urgencyScore = 2, actionProb = 0.95, actNowScore = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const others = ["alert", "review", "ignore"].filter((a) => a !== action);
      const rest = (1 - actionProb) / others.length;
      return {
        type: "choice",
        choice: action,
        probabilities: { [action]: actionProb, ...Object.fromEntries(others.map((o) => [o, rest])) },
        confidence: actionProb,
      };
    }
    if (name === "urgency") {
      const labels = ["routine", "urgent", "critical"] as const;
      const idx = Math.min(2, Math.max(0, urgencyScore));
      return {
        type: "score",
        score: urgencyScore,
        probabilities: Object.fromEntries(labels.map((l, i) => [l, i === idx ? 0.95 : 0.025])),
      };
    }
    return { type: "noul", noul: actNowScore, reason: "safe" };
  };
}

function makeHarness(opts: {
  policy?: any;
  backendCall?: (method: string, path: string, body?: any) => Promise<any>;
  jevHandler?: (name: string, q: Question) => Answer;
  llmResponses?: Record<string, any>;
  backendUp?: boolean;
} = {}) {
  const rpc = fakeRpc();
  const store = new McStore(rpc.rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const policyStore = { current: () => opts.policy ?? POLICY } as any;
  const gate = new Gate(policyStore);

  const backendCalls: Array<{ method: string; path: string; body: any }> = [];
  const backend = {
    call: async (method: string, path: string, body?: any) => {
      backendCalls.push({ method, path, body });
      if (opts.backendCall) return opts.backendCall(method, path, body);
      if (path.includes("/api/intelligence/ecg/analyze")) {
        return {
          ok: true,
          status: 200,
          data: {
            probabilities: { NORM: 0.05, MI: 0.88, STTC: 0.04, CD: 0.02, HYP: 0.01 },
            top: "MI",
            model: "ecg-ptbxl-v1",
          },
        };
      }
      if (path.includes("/api/alerts/agent")) {
        return { ok: true, status: 201, data: { alert: { _id: "alert_ecg_123" } } };
      }
      return { ok: true, status: 200, data: {} };
    },
  };

  const jev = new FakeJev(opts.jevHandler ?? jevAnswers("alert", 2));
  const llm = new FakeLlm(
    (prompt: string) => {
      if (prompt.includes("fact-only state")) {
        return {
          patientId: "pat_99",
          miProbability: 0.88,
          normProbability: 0.05,
          topClass: "MI",
        };
      }
      if (prompt.includes("alerts.create")) {
        return {
          tool: "alerts.create",
          arguments: {
            title: "Elevated MI Probability Observed on 12-lead ECG",
            summary: "ECG model analysis shows 0.88 probability of MI. Urgent clinician evaluation recommended.",
          },
        };
      }
      return {};
    },
  );

  const health = { isUp: (target: string) => (target === "backend" ? (opts.backendUp ?? true) : true) };

  const workflow = new EcgWorkflow({ jev, llm, audit, state, gate, backend, health });

  return { workflow, rpc, audit, state, gate, backendCalls, jev, llm };
}

describe("ECG Tool validation", () => {
  it("validates correct 12x1000 signal", () => {
    const validSignal = createDummySignal();
    expect(validateEcgArgs({ signal: validSignal })).toEqual([]);
    expect(validateEcgArgs({ signal: validSignal, lead_order: ["I", "II", "III", "AVR", "AVL", "AVF", "V1", "V2", "V3", "V4", "V5", "V6"] })).toEqual([]);
  });

  it("rejects non-objects or invalid shapes", () => {
    expect(validateEcgArgs(null)).toContain("args must be an object");
    expect(validateEcgArgs([])).toContain("args must be an object");
    expect(validateEcgArgs({ signal: [1, 2, 3] })[0]).toMatch(/12 leads/);

    const badSamples = Array.from({ length: 12 }, () => [1, 2, 3]);
    expect(validateEcgArgs({ signal: badSamples })[0]).toMatch(/1000 samples/);

    const badLeadOrder = createDummySignal();
    expect(validateEcgArgs({ signal: badLeadOrder, lead_order: ["I"] })[0]).toMatch(/12 strings/);
  });

  it("ecgAnalyzeTool calls backend proxy route", async () => {
    const mockClient = {
      call: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { top: "NORM" } }),
    };
    const validSignal = createDummySignal();
    const res = await ecgAnalyzeTool.run({ signal: validSignal }, mockClient as any);
    expect(res.ok).toBe(true);
    expect(mockClient.call).toHaveBeenCalledWith("POST", "/api/intelligence/ecg/analyze", {
      signal: validSignal,
      lead_order: undefined,
    });
  });
});

describe("ECG Autonomous Workflow", () => {
  it("happy path: uploads new ECG -> analyzes -> Jev alerts (critical) -> alert created with CRITICAL severity", async () => {
    const h = makeHarness({
      jevHandler: jevAnswers("alert", 2, 0.95), // urgency 2 = critical
    });

    const doc = makeEcgDoc();
    const event = makeEvent(doc, "ecg.uploaded");

    const outcome = await h.workflow.handle(event);
    expect(outcome).toBe("executed");

    // Verify analyze tool was called
    const analyzeCall = h.backendCalls.find((c) => c.path.includes("/api/intelligence/ecg/analyze"));
    expect(analyzeCall).toBeDefined();
    expect(analyzeCall?.body.signal).toHaveLength(12);

    // Verify alerts tool was called with code-owned CRITICAL severity
    const alertCall = h.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall).toBeDefined();
    expect(alertCall?.body.severity).toBe("CRITICAL");
    expect(alertCall?.body.patient_id).toBe("pat_99");
    expect(alertCall?.body.source_id).toBe("rec_ecg_1");
    expect(alertCall?.body.title).toBe("Elevated MI Probability Observed on 12-lead ECG");

    // Idempotency: duplicate event with same action is blocked
    const duplicateOutcome = await h.workflow.handle(event);
    expect(duplicateOutcome).toBe("blocked");
  });

  it("maps routine urgency to WARNING severity and urgent to HIGH", async () => {
    const h1 = makeHarness({ jevHandler: jevAnswers("alert", 0) }); // routine
    const res1 = await h1.workflow.handle(makeEvent(makeEcgDoc()));
    expect(res1).toBe("executed");
    const alertCall1 = h1.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall1?.body.severity).toBe("WARNING");

    const h2 = makeHarness({ jevHandler: jevAnswers("alert", 1) }); // urgent
    const res2 = await h2.workflow.handle(makeEvent(makeEcgDoc()));
    expect(res2).toBe("executed");
    const alertCall2 = h2.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall2?.body.severity).toBe("HIGH");
  });

  it("handles pre-analyzed ECG record without re-analyzing", async () => {
    const h = makeHarness();
    const doc = makeEcgDoc({
      analysis: {
        probabilities: { NORM: 0.1, MI: 0.85, STTC: 0.02, CD: 0.02, HYP: 0.01 },
        top: "MI",
        model: "ecg-ptbxl-v1",
        analyzedAt: "2026-11-13T00:00:00Z",
      },
    });
    const event = makeEvent(doc, "ecg.analyzed");

    const outcome = await h.workflow.handle(event);
    expect(outcome).toBe("executed");

    // ecg.analyze should NOT be called again
    const analyzeCall = h.backendCalls.find((c) => c.path.includes("/api/intelligence/ecg/analyze"));
    expect(analyzeCall).toBeUndefined();

    // alert should be created
    const alertCall = h.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall).toBeDefined();
  });

  it("skips when Jev decides ignore (e.g. normal ECG)", async () => {
    const h = makeHarness({
      jevHandler: jevAnswers("ignore", 0),
    });

    const outcome = await h.workflow.handle(makeEvent(makeEcgDoc()));
    expect(outcome).toBe("skipped");

    const alertCall = h.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall).toBeUndefined();
  });

  it("routes to review when Jev decides review or Gate yields review", async () => {
    const h = makeHarness({
      jevHandler: jevAnswers("review", 1),
    });

    const outcome = await h.workflow.handle(makeEvent(makeEcgDoc()));
    expect(outcome).toBe("review");

    const alertCall = h.backendCalls.find((c) => c.path.includes("/api/alerts/agent"));
    expect(alertCall).toBeUndefined();
  });

  it("blocks and enqueues when kill switch is engaged", async () => {
    const h = makeHarness();
    await h.state.setStopped(true);

    const event = makeEvent(makeEcgDoc());
    const outcome = await h.workflow.handle(event);
    expect(outcome).toBe("blocked");

    // Event should be enqueued
    const queued = await h.state.drain();
    expect(queued.length).toBeGreaterThan(0);
  });

  it("defers to pending when backend is down", async () => {
    const h = makeHarness({ backendUp: false });

    const outcome = await h.workflow.handle(makeEvent(makeEcgDoc()));
    expect(outcome).toBe("pending");
  });
});
