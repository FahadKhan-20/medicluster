import { describe, it, expect } from "vitest";
import {
  findMissedDoses,
  dateKey,
  RemindersWorkflow,
  REMINDER_JEV_QUESTIONS,
  REMINDER_STATE_PROMPT,
  REMINDER_ARGS_PROMPT,
  type MissedDose,
} from "../src/workflows/reminders.js";
import {
  toolForReminderAction,
  reminderNotifyTool,
  reminderAlertTool,
} from "../src/tools/reminders.js";
import { FakeJev, type Answer, type Decider, type Question } from "../src/judge/jev.js";
import { FakeLlm, ProviderError } from "../src/llm/provider.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

const POLICY = {
  threshold: 0.9,
  groups: { imaging: "auto", alerts: "auto", reminders: "auto" },
  rateLimitPerMinute: 30,
} as const;

function jevRules(action: string, prob = 0.95, urgency = 1, actNow = 0.95) {
  return (name: string, _q: Question): Answer => {
    if (name === "action") {
      const others = ["notify_patient", "escalate_alert", "ignore"].filter((a) => a !== action);
      const rest = (1 - prob) / others.length;
      return {
        type: "choice",
        choice: action,
        probabilities: { [action]: prob, ...Object.fromEntries(others.map((o) => [o, rest])) },
        confidence: prob,
      };
    }
    if (name === "urgency") {
      return {
        type: "score",
        score: urgency,
        probabilities: { "0": 0, "1": 1, "2": 0 },
      };
    }
    return { type: "noul", noul: actNow };
  };
}

function argsFor(user: string) {
  const parsed = JSON.parse(user);
  if (parsed.action === "notify_patient") {
    return {
      tool: "reminders.notify",
      arguments: { message: "Please take your medication as scheduled." },
    };
  }
  if (parsed.action === "escalate_alert") {
    return {
      tool: "alerts.create",
      arguments: {
        title: "Missed dose alert",
        summary: "Patient missed scheduled dose; clinician escalation needed.",
      },
    };
  }
  return { tool: "unknown", arguments: {} };
}

const STATE_FACTS = {
  patientId: "patient-1",
  medicationName: "Metformin",
  dosage: "500mg",
  scheduledDate: "2026-11-13",
  scheduledTime: "08:00",
  frequency: "daily",
  days: [],
  pillsLeft: 20,
  notes: "Take with food",
};

function setup(o: {
  jev?: Decider;
  llm?: (system: string, user: string) => unknown;
  up?: Record<string, boolean>;
  backendFails?: boolean;
  backendResult?: () => any;
  backendCall?: (method: string, path: string) => Promise<any>;
  policy?: any;
  now?: () => Date;
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
  const jev = o.jev ?? new FakeJev(jevRules("notify_patient"));
  const llm = new FakeLlm(
    o.llm ??
      ((system, user) => {
        if (system === REMINDER_STATE_PROMPT) return STATE_FACTS;
        return argsFor(user);
      }),
  );
  const workflow = new RemindersWorkflow({
    jev,
    llm,
    audit,
    state,
    gate,
    backend,
    store,
    health,
    now: o.now,
  });
  const audits = () => [...(db.get("agent_audit")?.values() ?? [])];
  return { workflow, calls, state, audit, audits, store, db, jev, llm, gate };
}

describe("findMissedDoses", () => {
  const now = new Date(2026, 10, 13, 10, 0, 0); // 10:00 local time (Nov 13, 2026)

  it("finds missed dose past grace period (30 min)", () => {
    const today = dateKey(now);
    const reminder = {
      _id: "rem-1",
      patientId: "p1",
      medicationName: "Lisinopril",
      dosage: "10mg",
      times: ["08:00"], // due 2 hours ago
      frequency: "daily",
      active: true,
      createdAt: new Date(2026, 10, 1, 0, 0, 0),
      doseLog: [],
    };
    const missed = findMissedDoses(reminder, now);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      reminderId: "rem-1",
      patientId: "p1",
      medicationName: "Lisinopril",
      date: today,
      time: "08:00",
    });
  });

  it("ignores dose within grace period (e.g. 15 min ago)", () => {
    // 09:45 is 15 minutes before 10:00
    const reminder = {
      _id: "rem-2",
      patientId: "p1",
      medicationName: "Lisinopril",
      times: ["09:45"],
      frequency: "daily",
      active: true,
      createdAt: new Date(2026, 10, 1, 0, 0, 0),
      doseLog: [],
    };
    const missed = findMissedDoses(reminder, now);
    expect(missed).toHaveLength(0);
  });

  it("ignores dose already recorded in doseLog", () => {
    const today = dateKey(now);
    const reminder = {
      _id: "rem-3",
      patientId: "p1",
      medicationName: "Lisinopril",
      times: ["08:00"],
      frequency: "daily",
      active: true,
      createdAt: new Date(2026, 10, 1, 0, 0, 0),
      doseLog: [{ date: today, time: "08:00", takenAt: new Date() }],
    };
    const missed = findMissedDoses(reminder, now);
    expect(missed).toHaveLength(0);
  });

  it("ignores inactive reminder or as-needed", () => {
    expect(findMissedDoses({ active: false, times: ["08:00"] }, now)).toHaveLength(0);
    expect(findMissedDoses({ active: true, frequency: "as-needed", times: ["08:00"] }, now)).toHaveLength(0);
  });

  it("respects weekly frequency days", () => {
    // 2026-11-13 is Friday
    const reminder = {
      _id: "rem-weekly",
      patientId: "p1",
      medicationName: "Methotrexate",
      times: ["08:00"],
      frequency: "weekly",
      days: ["Mon", "Wed"], // Friday is not scheduled
      active: true,
      createdAt: new Date(2026, 10, 1, 0, 0, 0),
      doseLog: [],
    };
    expect(findMissedDoses(reminder, now)).toHaveLength(0);

    const scheduled = { ...reminder, days: ["Fri"] };
    expect(findMissedDoses(scheduled, now)).toHaveLength(1);
  });
});

describe("REMINDER_JEV_QUESTIONS", () => {
  it("defines action, urgency, and act_now", () => {
    expect(REMINDER_JEV_QUESTIONS.action.type).toBe("choice");
    expect(Object.keys(REMINDER_JEV_QUESTIONS.action.criteria as object)).toEqual([
      "notify_patient",
      "escalate_alert",
      "ignore",
    ]);
    expect(REMINDER_JEV_QUESTIONS.urgency).toMatchObject({
      type: "score",
      criteria: ["routine", "urgent", "critical"],
    });
    expect(REMINDER_JEV_QUESTIONS.act_now.type).toBe("noul");
  });
});

describe("Reminders tools", () => {
  it("resolves tools by action", () => {
    expect(toolForReminderAction("notify_patient")).toBe(reminderNotifyTool);
    expect(toolForReminderAction("escalate_alert")).toBe(reminderAlertTool);
    expect(toolForReminderAction("ignore")).toBeUndefined();
    expect(toolForReminderAction("unknown")).toBeUndefined();
  });

  it("reminderNotifyTool validates arguments", async () => {
    const client = { call: async () => ({ ok: true as const, status: 200, data: {} }) };
    const res = await reminderNotifyTool.run(
      { reminder_id: "rem-1" }, // missing fields
      client as any,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing required argument");
  });
});

describe("RemindersWorkflow", () => {
  const missedDose: MissedDose = {
    reminderId: "rem-100",
    patientId: "patient-1",
    medicationName: "Metformin",
    dosage: "500mg",
    date: "2026-11-13",
    time: "08:00",
    due: new Date("2026-11-13T08:00:00.000Z"),
    frequency: "daily",
    pillsLeft: 15,
  };

  it("confident notify_patient executes reminder notification", async () => {
    const t = setup();
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("executed");

    expect(t.calls).toHaveLength(1);
    const call = t.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/reminders/rem-100/notify");
    expect(call.body).toMatchObject({
      reminder_id: "rem-100",
      patient_id: "patient-1",
      date: "2026-11-13",
      time: "08:00",
      message: "Please take your medication as scheduled.",
    });

    const key = `dose:rem-100:2026-11-13:08:00:notify_patient`;
    expect(await t.state.isDone(key)).toBe(true);

    const [audit] = t.audits();
    expect(audit.outcome).toBe("executed");
    const kinds = audit.steps.map((s: any) => s.kind);
    expect(kinds).toEqual(["state", "jev", "gate", "args", "tool"]);
  });

  it("confident escalate_alert executes alerts.create", async () => {
    const t = setup({ jev: new FakeJev(jevRules("escalate_alert", 0.96, 2)) });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("executed");

    expect(t.calls).toHaveLength(1);
    const call = t.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/alerts/agent");
    expect(call.body).toMatchObject({
      patient_id: "patient-1",
      source_id: "dose:rem-100:2026-11-13:08:00",
      severity: "CRITICAL",
      title: "Missed dose alert",
      summary: "Patient missed scheduled dose; clinician escalation needed.",
    });

    const key = `dose:rem-100:2026-11-13:08:00:escalate_alert`;
    expect(await t.state.isDone(key)).toBe(true);
  });

  it("ignore action skips without tool execution", async () => {
    const t = setup({ jev: new FakeJev(jevRules("ignore")) });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("jev_ignore");
    expect(t.calls).toHaveLength(0);

    const [audit] = t.audits();
    expect(audit.outcome).toBe("skipped");
  });

  it("treatment action in gate is routed to review", async () => {
    const t = setup({
      jev: new FakeJev((name: string) => {
        if (name === "action") return { type: "choice", choice: "dose_adjustment", probabilities: { dose_adjustment: 0.99 }, confidence: 0.99 };
        return { type: "noul", noul: 0.99 };
      }),
    });
    // If an action contains "dose", gate intercepts it
    const g = t.gate.check({
      group: "reminders",
      action: "dose_adjustment",
      actionProb: 0.99,
      actNow: 0.99,
      fallback: false,
      stopped: false,
      key: "k1",
      done: false,
    });
    expect(g).toEqual({ verdict: "review", reason: "treatment_requires_doctor" });
  });

  it("kill switch blocks and enqueues event", async () => {
    const t = setup();
    await t.state.setStopped(true);
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("stopped");
    expect(t.calls).toHaveLength(0);

    const queued = await t.state.drain();
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe("dose:rem-100:2026-11-13:08:00");
  });

  it("duplicate key blocks subsequent execution", async () => {
    const t = setup();
    const key = `dose:rem-100:2026-11-13:08:00:notify_patient`;
    await t.state.markDone(key);

    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("duplicate");
    expect(t.calls).toHaveLength(0);
  });

  it("low confidence routes to review", async () => {
    const t = setup({ jev: new FakeJev(jevRules("notify_patient", 0.7)) });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("review");
    expect(res.reason).toBe("low_confidence");
    expect(t.calls).toHaveLength(0);
  });

  it("jev fallback routes to review", async () => {
    const t = setup({
      jev: {
        decide: async () => ({
          answers: {
            action: { type: "choice", choice: "notify_patient", probabilities: { notify_patient: 0.95 } },
            act_now: { type: "noul", noul: 0.95 },
          },
          cost: 0,
          fallback: true,
        }),
      },
    });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("review");
    expect(res.reason).toBe("jev_fallback");
  });

  it("group off in policy blocks execution", async () => {
    const t = setup({
      policy: { threshold: 0.9, groups: { reminders: "off" }, rateLimitPerMinute: 30 },
    });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("group_off");
  });

  it("rate limited blocks execution after threshold", async () => {
    const t = setup();
    for (let i = 0; i < 30; i++) t.gate.record("reminders");
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("rate_limited");
  });

  it("LLM failure yields pending and enqueues event", async () => {
    const t = setup({
      llm: () => {
        throw new ProviderError("model down");
      },
    });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("pending");
    expect(res.reason).toBe("llm_unavailable");

    const queued = await t.state.drain();
    expect(queued).toHaveLength(1);
  });

  it("backend failure 500 yields pending", async () => {
    const t = setup({
      backendResult: () => ({ ok: false, status: 500, error: "Internal Error", retryable: true }),
    });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("pending");
    expect(res.reason).toBe("backend_unavailable");
  });

  it("backend failure 400 yields failed", async () => {
    const t = setup({
      backendResult: () => ({ ok: false, status: 400, error: "Bad Request", retryable: false }),
    });
    const res = await t.workflow.handleMissedDose(missedDose);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("backend_error");
  });

  it("handleReminderDoc detects and processes missed doses", async () => {
    const now = new Date("2026-11-13T12:00:00.000Z");
    const t = setup({ now: () => now });
    const reminder = {
      _id: "rem-batch",
      patientId: "p-batch",
      medicationName: "Aspirin",
      dosage: "81mg",
      times: ["08:00"],
      frequency: "daily",
      active: true,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
      doseLog: [],
    };

    const results = await t.workflow.handleReminderDoc(reminder, now);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("executed");
  });

  it("handleRealtimeRow only processes reminders collection", async () => {
    const t = setup();
    expect(await t.workflow.handleRealtimeRow({ collection: "patientmedias", data: {} })).toEqual([]);
    expect(await t.workflow.handleRealtimeRow({ collection: "other", data: {} })).toEqual([]);
  });

  it("checkAll scans active reminders from store", async () => {
    const now = new Date("2026-11-13T12:00:00.000Z");
    const t = setup({ now: () => now });
    await t.store.insert("reminders", {
      _id: "r1",
      patientId: "p1",
      medicationName: "DrugA",
      times: ["08:00"],
      frequency: "daily",
      active: true,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
      doseLog: [],
    });

    const report = await t.workflow.checkAll(now);
    expect(report.checked).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].outcome).toBe("executed");
  });
});
