import { describe, it, expect, vi } from "vitest";
import { AgentLoop, ARGS_PROMPT, JEV_QUESTIONS, STATE_PROMPT } from "../src/agent/loop.js";
import { FakeJev, fallbackAnswer, type Answer, type Decider, type Question } from "../src/judge/jev.js";
import { FakeLlm, ProviderError } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import type { Event } from "../src/events/events.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = { threshold: 0.9, groups: { imaging: "auto", alerts: "auto" }, rateLimitPerMinute: 30 } as const;

const DOC = {
  _id: "m1",
  gridfs_id: "g1",
  patient_id: "p1",
  file_type: "image",
  file_name: "chest.png",
  analysis: {
    analyzedAt: "2026-11-12T10:00:00.000Z",
    model: "cxr-v2",
    findings: [{ label: "pneumothorax", confidence: 0.97 }],
    heatmap_data_url: "data:image/png;base64,AAAA",
    localization: { boxes: [[1, 2, 3, 4]] },
  },
};

const analyzed = (doc: any = DOC): Event => ({
  id: `${doc._id}:${doc.analysis?.analyzedAt}`,
  type: "scan.analyzed",
  mediaId: doc._id,
  analyzedAt: doc.analysis?.analyzedAt,
  doc,
  at: "2026-11-12T10:00:01.000Z",
});

const uploaded = (doc: any = { _id: "m2", gridfs_id: "g2", patient_id: "p1", file_type: "image", file_name: "x.png" }): Event => ({
  id: `${doc._id}:new`,
  type: "scan.uploaded",
  mediaId: doc._id,
  doc,
  at: "2026-11-12T10:00:01.000Z",
});

const STATE = { patientId: "p1", modality: "xray", fileName: "chest.png", findings: ["pneumothorax 0.97"], model: "cxr-v2" };

function jevRules(action: string, prob: number, urgency = 2, actNow = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const others = ["analyze", "alert", "request_review", "ignore"].filter((a) => a !== action);
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

function argsFor(user: string) {
  const { action } = JSON.parse(user);
  if (action === "alert") return { tool: "alerts.create", arguments: { title: "Pneumothorax suspected", summary: "Model finding 0.97", severity: "WARNING" } };
  if (action === "analyze") return { tool: "imaging.analyze", arguments: { fileId: "evil" } };
  return { tool: "imaging.request_review", arguments: { fileId: "evil" } };
}

function setup(o: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  up?: Record<string, boolean>;
  backendFails?: boolean;
  backendResult?: () => any;
  backendCall?: (method: string, path: string) => Promise<any>;
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
      if (o.backendCall) return o.backendCall(method, path);
      if (o.backendResult) return o.backendResult();
      if (o.backendFails) return { ok: false as const, status: 400, error: "HTTP 400", retryable: false as const };
      return { ok: true as const, status: 200, data: {} };
    },
  };
  const health = { isUp: (n: string) => o.up?.[n] ?? true };
  const jev = o.jev ?? new FakeJev(jevRules("alert", 0.95));
  const llm = new FakeLlm(o.llm ?? ((system, user) => (system === STATE_PROMPT ? STATE : argsFor(user))));
  const loop = new AgentLoop({ jev, llm, audit, state, gate, backend, health, store });
  const audits = () => [...(db.get("agent_audit")?.values() ?? [])];
  return { loop, calls, state, audit, audits, jev, llm, store };
}

describe("JEV_QUESTIONS", () => {
  it("has action, urgency and act_now", () => {
    expect(JEV_QUESTIONS.action.type).toBe("choice");
    expect(Object.keys(JEV_QUESTIONS.action.criteria as object)).toEqual(["analyze", "alert", "request_review", "ignore"]);
    expect(JEV_QUESTIONS.urgency).toMatchObject({ type: "score", criteria: ["routine", "urgent", "critical"] });
    expect(JEV_QUESTIONS.act_now).toEqual({
      type: "noul",
      instructions: "Acting now on the chosen action is safe and correct for this patient",
    });
  });
});

describe("AgentLoop", () => {
  it("critical at 0.95 creates alert", async () => {
    const t = setup();
    expect(await t.loop.handle(analyzed())).toBe("executed");
    const alerts = t.calls.filter((c) => c.method === "POST" && c.path === "/api/alerts/agent");
    expect(alerts).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
    const [a] = t.audits();
    expect(alerts[0].body).toEqual({
      patient_id: "p1",
      source_id: "m1",
      severity: "CRITICAL",
      title: "Pneumothorax suspected",
      summary: "Model finding 0.97",
      jev_probabilities: {
        action: { alert: 0.95, analyze: (1 - 0.95) / 3, request_review: (1 - 0.95) / 3, ignore: (1 - 0.95) / 3 },
        urgency: { "0": 0, "1": 0, "2": 1 },
        act_now: 0.95,
      },
      audit_id: a._id,
      idem_key: `${analyzed().id}:alert`,
    });
    expect(a.steps.map((s: any) => s.kind)).toEqual(expect.arrayContaining(["state", "jev", "gate", "tool"]));
    expect(a.outcome).toBe("executed");
    expect(await t.state.isDone("m1:2026-11-12T10:00:00.000Z:alert")).toBe(true);
  });

  it("urgency maps to severity", async () => {
    for (const [u, sev] of [[0, "WARNING"], [1, "HIGH"]] as const) {
      const t = setup({ jev: new FakeJev(jevRules("alert", 0.95, u)) });
      expect(await t.loop.handle(analyzed())).toBe("executed");
      expect(t.calls[0].body.severity).toBe(sev);
    }
  });

  it("strips heatmap and localization before Gemini and Jev", async () => {
    const t = setup();
    await t.loop.handle(analyzed());
    for (const c of t.llm.calls) {
      expect(c.user).not.toContain("heatmap_data_url");
      expect(c.user).not.toContain("localization");
    }
    expect(JSON.stringify((t.jev as FakeJev).calls)).not.toContain("heatmap_data_url");
    expect(JSON.parse(t.llm.calls[0].user).analysis.findings).toEqual(DOC.analysis.findings);
    expect(DOC.analysis.heatmap_data_url).toBeDefined();
  });

  it("truncates alert title and summary", async () => {
    const t = setup({
      llm: (s) => (s === STATE_PROMPT ? STATE : { tool: "alerts.create", arguments: { title: "t".repeat(300), summary: "s".repeat(3000) } }),
    });
    expect(await t.loop.handle(analyzed())).toBe("executed");
    expect(t.calls[0].body.title).toHaveLength(200);
    expect(t.calls[0].body.summary).toHaveLength(2000);
  });

  it("0.6 confidence requests review", async () => {
    const t = setup({ jev: new FakeJev(jevRules("alert", 0.6)) });
    expect(await t.loop.handle(analyzed())).toBe("review");
    expect(t.calls).toEqual([{ method: "POST", path: "/api/media/review/g1", body: undefined }]);
    expect(t.calls.some((c) => c.path === "/api/alerts/agent")).toBe(false);
    expect(t.audits()[0].reason).toBe("low_confidence");
    // a repeat does not request a second review (skipped via decided marker)
    expect(await t.loop.handle(analyzed())).toBe("skipped");
    expect(t.calls).toHaveLength(1);
  });

  it("review on upload is audit-only", async () => {
    const t = setup({ jev: new FakeJev(jevRules("analyze", 0.6)) });
    expect(await t.loop.handle(uploaded())).toBe("review");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].outcome).toBe("review");
  });

  it("upload with analyze executes analysis", async () => {
    const t = setup({ jev: new FakeJev(jevRules("analyze", 0.95)) });
    expect(await t.loop.handle(uploaded())).toBe("executed");
    expect(t.calls).toEqual([{ method: "POST", path: "/api/media/analyze/g2", body: { model_name: "densenet121-res224-all" } }]);
  });

  it("jev fallback never executes", async () => {
    const jev: Decider = {
      async decide(_s, questions) {
        const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, fallbackAnswer(q)]));
        // even a fallback that somehow points at a confident action must not execute
        answers.action = { type: "choice", choice: "alert", probabilities: { alert: 1 }, confidence: 1 };
        answers.act_now = { type: "noul", noul: 1 };
        return { answers, cost: 0, fallback: true, error: "down" };
      },
    };
    const t = setup({ jev });
    expect(await t.loop.handle(analyzed())).toBe("review");
    expect(t.calls.some((c) => c.path === "/api/alerts/agent")).toBe(false);
    expect(t.audits()[0].reason).toBe("jev_fallback");
  });

  it("llm tool mismatch is rejected", async () => {
    const t = setup({
      llm: (s) => (s === STATE_PROMPT ? STATE : { tool: "imaging.analyze", arguments: { fileId: "g1" } }),
    });
    expect(await t.loop.handle(analyzed())).toBe("failed");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0]).toMatchObject({ outcome: "failed", reason: "llm_tool_mismatch" });
  });

  it("malformed llm results leave the event pending", async () => {
    for (const bad of [null, [], "x"]) {
      const t = setup({ llm: () => bad });
      expect(await t.loop.handle(analyzed())).toBe("pending");
      expect((t.jev as FakeJev).calls).toHaveLength(0);
    }
    for (const bad of [null, { tool: 1, arguments: {} }, { tool: "alerts.create" }, { tool: "alerts.create", arguments: [] }]) {
      const t = setup({ llm: (s) => (s === STATE_PROMPT ? STATE : bad) });
      expect(await t.loop.handle(analyzed())).toBe("pending");
      expect(t.calls).toHaveLength(0);
      expect(await t.state.drain()).toHaveLength(1);
    }
  });

  it("gemini down leaves event pending", async () => {
    const t = setup({
      llm: () => {
        throw new ProviderError("provider HTTP 503");
      },
    });
    expect(await t.loop.handle(analyzed())).toBe("pending");
    expect((t.jev as FakeJev).calls).toHaveLength(0);
    expect((await t.state.drain()).map((e) => e.id)).toEqual(["m1:2026-11-12T10:00:00.000Z"]);
  });

  it("stopped queues event", async () => {
    const t = setup();
    await t.state.setStopped(true);
    const e = analyzed();
    expect(await t.loop.handle(e)).toBe("blocked");
    expect((await t.state.drain()).map((x) => x.id)).toEqual([e.id]);
    expect(t.llm.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it("documents are skipped without decisions", async () => {
    const t = setup();
    expect(await t.loop.handle(analyzed({ ...DOC, file_type: "document" }))).toBe("skipped");
    expect((t.jev as FakeJev).calls.length).toBe(0);
    expect(t.llm.calls).toHaveLength(0);
  });

  it("ignore is skipped", async () => {
    const t = setup({ jev: new FakeJev(jevRules("ignore", 0.99)) });
    expect(await t.loop.handle(analyzed())).toBe("skipped");
    expect(t.calls).toHaveLength(0);
  });

  it("service events are skipped", async () => {
    const t = setup();
    expect(await t.loop.handle({ id: "ml:up:x", type: "service.up", service: "ml", at: "x" })).toBe("skipped");
    expect(await t.loop.handle({ id: "ml:down:x", type: "service.down", service: "ml", at: "x" })).toBe("skipped");
  });

  it("re-analysis with same analyzedAt creates no second alert", async () => {
    const t = setup();
    expect(await t.loop.handle(analyzed())).toBe("executed");
    expect(await t.loop.handle(analyzed())).toBe("skipped");
    expect(t.calls.filter((c) => c.path === "/api/alerts/agent")).toHaveLength(1);
    expect(t.audits()).toHaveLength(1);
  });

  it("ml worker down marks analysis_unavailable", async () => {
    const t = setup({ up: { ml: false } });
    const e = uploaded();
    expect(await t.loop.handle(e)).toBe("pending");
    expect(t.audits()[0]).toMatchObject({ outcome: "pending", reason: "analysis_unavailable" });
    expect((await t.state.drain()).map((x) => x.id)).toEqual([e.id]);
    expect(t.llm.calls).toHaveLength(0);
  });

  it("backend down on upload marks analysis_unavailable", async () => {
    const t = setup({ up: { backend: false } });
    expect(await t.loop.handle(uploaded())).toBe("pending");
    expect(t.audits()[0].reason).toBe("analysis_unavailable");
  });

  it("retryPending reprocesses after recovery", async () => {
    let down = true;
    const t = setup({
      llm: (s, u) => {
        if (down) throw new ProviderError("provider HTTP 503");
        return s === STATE_PROMPT ? STATE : argsFor(u);
      },
    });
    expect(await t.loop.handle(analyzed())).toBe("pending");
    expect(await t.loop.retryPending()).toBe(1);
    expect(await t.state.drain()).toHaveLength(1);
    down = false;
    expect(await t.loop.retryPending(new Date(Date.now() + 130_000).toISOString())).toBe(1);
    expect(t.audits().at(-1).outcome).toBe("executed");
    expect(t.calls.filter((c) => c.path === "/api/alerts/agent")).toHaveLength(1);
    expect(await t.state.drain()).toHaveLength(0);
  });

  it("retryPending keeps events queued while stopped", async () => {
    const t = setup();
    await t.state.setStopped(true);
    await t.loop.handle(analyzed());
    await t.loop.retryPending();
    expect(await t.state.drain()).toHaveLength(1);
    await t.state.setStopped(false);
    expect(await t.loop.retryPending()).toBe(1);
    expect(await t.state.drain()).toHaveLength(0);
    expect(t.calls).toHaveLength(1);
  });

  it("backend failure gives failed", async () => {
    const t = setup({ backendFails: true });
    expect(await t.loop.handle(analyzed())).toBe("failed");
    expect(await t.state.isDone("m1:2026-11-12T10:00:00.000Z:alert")).toBe(false);
  });

  // ---- fix round 1 ----

  it("kill switch flipped during the args call prevents the write", async () => {
    let t: ReturnType<typeof setup>;
    t = setup({
      llm: (s, u) => {
        if (s === STATE_PROMPT) return STATE;
        void t.state.setStopped(true);
        return argsFor(u);
      },
    });
    expect(await t.loop.handle(analyzed())).toBe("blocked");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].reason).toBe("stopped");
    expect(await t.state.drain()).toHaveLength(1);
  });

  it("kill switch flipped during the decision blocks the review write", async () => {
    let t: ReturnType<typeof setup>;
    const rules = jevRules("alert", 0.6);
    t = setup({
      jev: new FakeJev((n, q) => {
        if (n === "act_now") void t.state.setStopped(true);
        return rules(n, q);
      }),
    });
    expect(await t.loop.handle(analyzed())).toBe("blocked");
    expect(t.calls).toHaveLength(0);
  });

  it("review write obeys imaging policy", async () => {
    const t = setup({
      jev: new FakeJev(jevRules("alert", 0.6)),
      policy: { ...POLICY, groups: { imaging: "off", alerts: "auto" } },
    });
    expect(await t.loop.handle(analyzed())).toBe("review");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].steps.find((s: any) => s.kind === "review_gate").data).toMatchObject({ verdict: "blocked", reason: "group_off" });
  });

  it("concurrent handles of the same event post one alert", async () => {
    const t = setup();
    const outcomes = await Promise.all([t.loop.handle(analyzed()), t.loop.handle(analyzed())]);
    expect(outcomes.sort()).toEqual(["blocked", "executed"]);
    expect(t.calls.filter((c) => c.path === "/api/alerts/agent")).toHaveLength(1);
  });

  it("overlapping retryPending calls share one run", async () => {
    let down = true;
    const t = setup({
      llm: (s, u) => {
        if (down) throw new ProviderError("provider HTTP 503");
        return s === STATE_PROMPT ? STATE : argsFor(u);
      },
    });
    await t.loop.handle(analyzed());
    down = false;
    const a = t.loop.retryPending();
    const b = t.loop.retryPending();
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(t.calls.filter((c) => c.path === "/api/alerts/agent")).toHaveLength(1);
  });

  it("code-owned stage overrides Gemini and reaches Jev", async () => {
    const t = setup({ llm: (s, u) => (s === STATE_PROMPT ? { ...STATE, stage: "uploaded", has_analysis: false } : argsFor(u)) });
    await t.loop.handle(analyzed());
    expect((t.jev as FakeJev).calls[0].state).toMatchObject({ stage: "analyzed", has_analysis: true });
    const u = setup({ jev: new FakeJev(jevRules("analyze", 0.95)) });
    await u.loop.handle(uploaded());
    expect((u.jev as FakeJev).calls[0].state).toMatchObject({ stage: "uploaded", has_analysis: false });
  });

  it("alert on upload is review, audit-only", async () => {
    for (const action of ["alert", "request_review"]) {
      const t = setup({ jev: new FakeJev(jevRules(action, 0.95)) });
      expect(await t.loop.handle(uploaded())).toBe("review");
      expect(t.calls).toHaveLength(0);
      expect(t.audits()[0].reason).toBe("stage_not_allowed");
    }
  });

  it("analyze on an analysed scan requests review instead", async () => {
    const t = setup({ jev: new FakeJev(jevRules("analyze", 0.95)) });
    expect(await t.loop.handle(analyzed())).toBe("review");
    expect(t.calls).toEqual([{ method: "POST", path: "/api/media/review/g1", body: undefined }]);
  });

  it("partial Jev answers never execute", async () => {
    const rules = jevRules("alert", 0.95);
    const jev: Decider = {
      async decide(_s, questions) {
        const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, rules(n, q)]));
        answers.urgency = fallbackAnswer(questions.urgency);
        return { answers, cost: 0, fallback: false, error: "invalid or missing answers: urgency" };
      },
    };
    const t = setup({ jev });
    expect(await t.loop.handle(analyzed())).toBe("review");
    expect(t.calls.some((c) => c.path === "/api/alerts/agent")).toBe(false);
    expect(t.audits()[0].reason).toBe("jev_fallback");
  });

  it("retryable backend failures leave the event pending", async () => {
    for (const r of [
      { ok: false, status: 503, error: "HTTP 503", retryable: false },
      { ok: false, status: 0, error: "TypeError: fetch failed", retryable: false },
    ]) {
      const t = setup({ backendResult: () => r });
      expect(await t.loop.handle(analyzed())).toBe("pending");
      expect(await t.state.drain()).toHaveLength(1);
      expect(await t.state.isDone("m1:2026-11-12T10:00:00.000Z:alert")).toBe(false);
    }
    const t = setup({ jev: new FakeJev(jevRules("alert", 0.6)), backendResult: () => ({ ok: false, status: 502, error: "x", retryable: false }) });
    expect(await t.loop.handle(analyzed())).toBe("pending");
  });

  it("missing or invalid alert text leaves the event pending", async () => {
    for (const args of [{ summary: "s" }, { title: "", summary: "s" }, { title: "t", summary: 5 }]) {
      const t = setup({ llm: (s) => (s === STATE_PROMPT ? STATE : { tool: "alerts.create", arguments: args }) });
      expect(await t.loop.handle(analyzed())).toBe("pending");
      expect(t.calls).toHaveLength(0);
    }
  });

  it("missing gridfs_id is invalid_args", async () => {
    const { gridfs_id: _g, ...doc } = { ...DOC, _id: "m3" };
    const t = setup({ jev: new FakeJev(jevRules("request_review", 0.95)) });
    expect(await t.loop.handle(analyzed(doc))).toBe("failed");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].reason).toBe("invalid_args");
  });

  it("analyze ignores LLM model_name; alert args prompt shows only title and summary", async () => {
    const t = setup({
      jev: new FakeJev(jevRules("analyze", 0.95)),
      llm: (s) => (s === STATE_PROMPT ? STATE : { tool: "imaging.analyze", arguments: { model_name: "other" } }),
    });
    expect(await t.loop.handle(uploaded())).toBe("executed");
    expect(t.calls[0].body).toEqual({ model_name: "densenet121-res224-all" });
    const a = setup();
    await a.loop.handle(analyzed());
    const sent = JSON.parse(a.llm.calls.find((c) => c.system === ARGS_PROMPT)!.user);
    expect(Object.keys(sent.tool.schema.properties)).toEqual(["title", "summary"]);
  });

  // ---- fix round 2 ----

  it("concurrent reviews of the same event post one request_review", async () => {
    const t = setup({ jev: new FakeJev(jevRules("alert", 0.6)) });
    const outcomes = await Promise.all([t.loop.handle(analyzed()), t.loop.handle(analyzed())]);
    expect(t.calls.filter((c) => c.path === "/api/media/review/g1")).toHaveLength(1);
    expect(outcomes.sort()).toEqual(["blocked", "review"]);
  });

  it("in-flight duplicate during retry does not ack", async () => {
    let down = true;
    let release!: (r: any) => void;
    let entered!: () => void;
    const inWrite = new Promise<void>((r) => (entered = r));
    const t = setup({
      llm: (s, u) => {
        if (down) throw new ProviderError("provider HTTP 503");
        return s === STATE_PROMPT ? STATE : argsFor(u);
      },
      backendCall: () => {
        entered();
        return new Promise((r) => (release = r));
      },
    });
    const e = analyzed();
    expect(await t.loop.handle(e)).toBe("pending");
    down = false;
    const ack = vi.spyOn(t.state, "ack");
    const live = t.loop.handle(e);
    await inWrite;
    expect(await t.loop.retryPending()).toBe(1);
    expect(ack).not.toHaveBeenCalled();
    expect(t.audits().at(-1)).toMatchObject({ outcome: "blocked", reason: "duplicate" });
    release({ ok: false, status: 503, error: "HTTP 503", retryable: false });
    expect(await live).toBe("pending");
    expect((await t.state.drain()).map((x) => x.id)).toEqual([e.id]);
  });

  it("408 and 429 backend responses are retryable", async () => {
    for (const [status, expectedReason] of [[408, "backend_unavailable"], [429, "rate_limited"]] as const) {
      const t = setup({ backendResult: () => ({ ok: false, status, error: `HTTP ${status}`, retryable: false }) });
      expect(await t.loop.handle(analyzed())).toBe("pending");
      expect(t.audits()[0].reason).toBe(expectedReason);
      expect(await t.state.drain()).toHaveLength(1);
    }
    const t = setup({ backendResult: () => ({ ok: false, status: 404, error: "HTTP 404", retryable: false }) });
    expect(await t.loop.handle(analyzed())).toBe("failed");
  });

  // ---- Critical #1 and review findings tests ----

  it("fresh scan.uploaded is delayed 120s and not analysed immediately", async () => {
    const t = setup();
    const freshDoc = { _id: "m_fresh", gridfs_id: "g_fresh", patient_id: "p1", file_type: "image", file_name: "chest.png" };
    const freshEvent: Event = {
      id: "m_fresh:new",
      type: "scan.uploaded",
      mediaId: "m_fresh",
      doc: freshDoc,
      at: new Date().toISOString(),
    };
    const outcome = await t.loop.handle(freshEvent);
    expect(outcome).toBe("pending");
    expect(t.calls).toHaveLength(0); // no analyze called!
    expect(t.audits()).toHaveLength(0); // no audit created during delay!
    const queueDocs = await t.state.drain();
    expect(queueDocs).toHaveLength(1);
    expect(queueDocs[0].notBefore).toBeDefined();
    // before 120s, retryPending does not run it
    expect(await t.loop.retryPending()).toBe(0);
    expect(t.calls).toHaveLength(0);
  });

  it("due scan.uploaded re-reads media doc from store and skips if already analysed", async () => {
    const t = setup();
    const freshDoc = { _id: "m_fresh", gridfs_id: "g_fresh", patient_id: "p1", file_type: "image", file_name: "chest.png" };
    // Insert into store as already analysed by imaging page
    await t.store.insert("patientmedias", {
      _id: "m_fresh",
      analysis: { analyzedAt: "2026-11-12T10:01:00.000Z", model: "densenet121" },
    });
    const dueEvent: Event = {
      id: "m_fresh:new",
      type: "scan.uploaded",
      mediaId: "m_fresh",
      doc: freshDoc,
      at: new Date(Date.now() - 130_000).toISOString(),
    };
    const outcome = await t.loop.handle(dueEvent);
    expect(outcome).toBe("skipped");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].reason).toBe("already_analyzed");
  });

  it("due scan.uploaded with brain/NIfTI hints requests review audit-only", async () => {
    const t = setup({ jev: new FakeJev(jevRules("analyze", 0.95)) });
    const brainDoc = { _id: "m_brain", gridfs_id: "g_brain", patient_id: "p1", file_type: "image", file_name: "brain_mri_t1.png" };
    const dueEvent: Event = {
      id: "m_brain:new",
      type: "scan.uploaded",
      mediaId: "m_brain",
      doc: brainDoc,
      at: new Date(Date.now() - 130_000).toISOString(),
    };
    const outcome = await t.loop.handle(dueEvent);
    expect(outcome).toBe("review");
    expect(t.calls).toHaveLength(0); // audit only!
    expect(t.audits()[0].reason).toBe("brain_or_nifti_requires_review");
  });

  it("re-reads doc right before every write: skips write if doc was analysed concurrently", async () => {
    const t = setup({ jev: new FakeJev(jevRules("analyze", 0.95)) });
    const plainDoc = { _id: "m_race", gridfs_id: "g_race", patient_id: "p1", file_type: "image", file_name: "chest.png", mimetype: "image/png" };
    await t.store.insert("patientmedias", {
      ...plainDoc,
    });
    // Simulate concurrent analysis saved in store right before write
    (t.loop as any).d.llm = new FakeLlm((system, user) => {
      if (system === STATE_PROMPT) {
        void t.store.update("patientmedias", { _id: "m_race" }, {
          $set: { analysis: { analyzedAt: new Date().toISOString(), model: "user-model" } },
        });
        return STATE;
      }
      return argsFor(user);
    });
    const dueEvent: Event = {
      id: "m_race:new",
      type: "scan.uploaded",
      mediaId: "m_race",
      doc: plainDoc,
      at: new Date(Date.now() - 130_000).toISOString(),
    };
    const outcome = await t.loop.handle(dueEvent);
    expect(outcome).toBe("skipped");
    expect(t.calls).toHaveLength(0);
    expect(t.audits()[0].reason).toBe("already_analyzed");
  });

  it("patient imaging-session prevents alerts and backend review", async () => {
    const t = setup({ jev: new FakeJev(jevRules("alert", 0.95)) });
    const sessionDoc = { ...DOC, patient_id: "imaging-session" };
    const outcome = await t.loop.handle(analyzed(sessionDoc));
    expect(outcome).toBe("review");
    expect(t.calls).toHaveLength(0); // neither alert nor review POST called!
  });

  it("non-image upload skips immediately without creating audit entry", async () => {
    const t = setup();
    const docEvent: Event = {
      id: "doc1:new",
      type: "scan.uploaded",
      mediaId: "doc1",
      doc: { _id: "doc1", file_type: "document" },
      at: new Date().toISOString(),
    };
    const outcome = await t.loop.handle(docEvent);
    expect(outcome).toBe("skipped");
    expect(t.audits()).toHaveLength(0); // no audit doc created!
  });

  it("strips heatmap_data_url and localization from audit tool step", async () => {
    const t = setup({
      backendResult: () => ({
        ok: true,
        status: 200,
        data: {
          analysis: {
            findings: [],
            heatmap_data_url: "data:image/png;base64,SECRET_PIXELS",
            localization: { box: [1, 2] },
          },
        },
      }),
    });
    await t.loop.handle(analyzed());
    const toolStep = t.audits()[0].steps.find((s: any) => s.kind === "tool");
    expect(toolStep).toBeDefined();
    const str = JSON.stringify(toolStep);
    expect(str).not.toContain("SECRET_PIXELS");
    expect(str).not.toContain("localization");
  });

  it("attempt counter with exponential backoff caps at 10 attempts then fails", async () => {
    let attemptsCount = 0;
    const t = setup({
      backendResult: () => {
        attemptsCount++;
        return { ok: false, status: 503, error: "HTTP 503", retryable: false };
      },
    });
    const e = analyzed();
    expect(await t.loop.handle(e)).toBe("pending");
    for (let i = 1; i <= 9; i++) {
      const futureTime = new Date(Date.now() + 2_000_000 * 1000).toISOString();
      await t.loop.retryPending(futureTime);
    }
    const finalRun = await t.loop.retryPending(new Date(Date.now() + 3_000_000 * 1000).toISOString());
    expect(finalRun).toBe(1);
    const lastAudit = t.audits().at(-1);
    expect(lastAudit.outcome).toBe("failed");
    expect(lastAudit.reason).toBe("max_attempts");
    expect(await t.state.drain()).toHaveLength(0); // acked / cleared!
  });
});
