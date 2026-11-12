import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PharmacyWorkflow,
  registerPharmacyWorkflow,
  STOCK_LOW_JEV_QUESTIONS,
  STUCK_ORDERS_JEV_QUESTIONS,
  REFILL_SUGGESTION_JEV_QUESTIONS,
  dateKey,
} from "../src/workflows/pharmacy.js";
import {
  pharmacyAlertTool,
  pharmacyRefillSuggestionTool,
  pharmacyStockLowTool,
  pharmacyStuckOrdersTool,
  fetchLowStock,
  fetchStuckOrders,
  postRefillSuggestion,
  postPharmacyAlert,
} from "../src/tools/pharmacy.js";
import { PolicyStore } from "../src/control/policy.js";
import { Gate } from "../src/control/gate.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { McStore } from "../src/store/mc.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

function makeLlm(replyFn?: (system: string, user: string) => any) {
  return {
    complete: vi.fn(),
    json: vi.fn(async (system: string, user: string) => {
      if (replyFn) return replyFn(system, user);
      if (system.includes("stock")) {
        return {
          pharmacyId: "ph-1",
          drug: "Amoxicillin",
          strength: "500mg",
          quantity: 5,
          lowStockThreshold: 20,
          deficit: 15,
        };
      }
      if (system.includes("stuck")) {
        return {
          orderId: "ord-1",
          pharmacyId: "ph-1",
          patientId: "pat-1",
          status: "accepted",
          fulfilment: "delivery",
          hoursInCurrentState: 4,
          stuckReason: "Courier delay",
        };
      }
      if (system.includes("refill")) {
        return {
          patientId: "pat-1",
          reminderId: "rem-1",
          medicationName: "Metformin",
          dosage: "500mg",
          pillsLeft: 0,
          refillsRemaining: 0,
          hasActiveOrder: false,
          missedDate: "2026-11-13",
          missedTime: "08:00",
        };
      }
      // Args prompt
      return {
        tool: "pharmacy.alert",
        arguments: {
          title: "Alert Generated",
          summary: "Summary of facts",
          reason: "Missed dose with zero refills remaining",
        },
      };
    }),
  } as any;
}

function makeJev(choiceVal = "alert", scoreVal = 2, noulVal = 0.95) {
  return {
    decide: vi.fn(async () => ({
      answers: {
        action: { choice: choiceVal, probabilities: { [choiceVal]: 0.95 } },
        urgency: { score: scoreVal, probabilities: { routine: 0.05, urgent: 0.1, critical: 0.85 } },
        act_now: { noul: noulVal },
      },
      fallback: false,
    })),
  } as any;
}

describe("Pharmacy Tools", () => {
  let backendCalls: Array<{ method: string; path: string; body?: unknown }>;
  let mockBackend: any;

  beforeEach(() => {
    backendCalls = [];
    mockBackend = {
      call: vi.fn(async (method: string, path: string, body?: unknown) => {
        backendCalls.push({ method, path, body });
        if (path === "/api/pharmacy/agent/stock-low") {
          return { ok: true, status: 200, data: { items: [{ pharmacyId: "ph-1", drug: "Amoxicillin", quantity: 5, lowStockThreshold: 20 }] } };
        }
        if (path === "/api/pharmacy/agent/stuck-orders") {
          return { ok: true, status: 200, data: { items: [{ orderId: "ord-1", pharmacyId: "ph-1", patientId: "pat-1", status: "accepted" }] } };
        }
        if (path === "/api/pharmacy/agent/refill-suggestion") {
          return { ok: true, status: 201, data: { suggestionId: "sug-1", status: "pending_clinician" } };
        }
        if (path === "/api/alerts/agent") {
          return { ok: true, status: 201, data: { alertId: "alt-1" } };
        }
        return { ok: false, status: 404, error: "not found", retryable: false };
      }),
    };
  });

  it("pharmacy.stock_low and fetchLowStock query GET /api/pharmacy/agent/stock-low", async () => {
    const res1 = await fetchLowStock(mockBackend);
    expect(res1.ok).toBe(true);
    expect(backendCalls[0]).toEqual({ method: "GET", path: "/api/pharmacy/agent/stock-low", body: undefined });

    const res2 = await pharmacyStockLowTool.run({}, mockBackend);
    expect(res2.ok).toBe(true);
    expect(backendCalls[1]).toEqual({ method: "GET", path: "/api/pharmacy/agent/stock-low", body: undefined });
  });

  it("pharmacy.stuck_orders and fetchStuckOrders query GET /api/pharmacy/agent/stuck-orders", async () => {
    const res1 = await fetchStuckOrders(mockBackend);
    expect(res1.ok).toBe(true);
    expect(backendCalls[0]).toEqual({ method: "GET", path: "/api/pharmacy/agent/stuck-orders", body: undefined });

    const res2 = await pharmacyStuckOrdersTool.run({}, mockBackend);
    expect(res2.ok).toBe(true);
    expect(backendCalls[1]).toEqual({ method: "GET", path: "/api/pharmacy/agent/stuck-orders", body: undefined });
  });

  it("pharmacy.refill_suggestion validates schema strictly and calls POST /api/pharmacy/agent/refill-suggestion", async () => {
    // Missing required fields
    const invalidRes = await pharmacyRefillSuggestionTool.run({ patientId: "p1" }, mockBackend);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.error).toContain("missing required argument");

    // Unexpected argument
    const unexpectedRes = await pharmacyRefillSuggestionTool.run({
      patientId: "p1",
      reminderId: "r1",
      medicationName: "Metformin",
      dosage: "500mg",
      reason: "Missed dose",
      auditId: "aud-1",
      extraUnknown: "bad",
    }, mockBackend);
    expect(unexpectedRes.ok).toBe(false);
    expect(unexpectedRes.error).toContain("unexpected argument");

    // Valid arguments
    const validArgs = {
      patientId: "p1",
      reminderId: "r1",
      medicationName: "Metformin",
      dosage: "500mg",
      reason: "Missed dose with zero pills left",
      auditId: "aud-1",
      suggestedAction: "refill_suggestion",
      idemKey: "pharmacy:refill:r1:p1:2026-11-13",
    };
    const validRes = await pharmacyRefillSuggestionTool.run(validArgs, mockBackend);
    expect(validRes.ok).toBe(true);
    expect(backendCalls[0].method).toBe("POST");
    expect(backendCalls[0].path).toBe("/api/pharmacy/agent/refill-suggestion");
    expect(backendCalls[0].body).toEqual(validArgs);

    // postRefillSuggestion helper
    await postRefillSuggestion(mockBackend, validArgs);
    expect(backendCalls[1].method).toBe("POST");
    expect(backendCalls[1].path).toBe("/api/pharmacy/agent/refill-suggestion");
  });

  it("pharmacy.alert validates schema strictly and calls POST /api/alerts/agent", async () => {
    // Invalid severity enum
    const badEnumRes = await pharmacyAlertTool.run({
      patient_id: "pharmacy:ph-1",
      source_id: "stock:ph-1:Amoxicillin",
      severity: "LOW", // not in enum
      title: "Low stock",
      summary: "Stock is low",
      jev_probabilities: {},
      audit_id: "aud-1",
    }, mockBackend);
    expect(badEnumRes.ok).toBe(false);
    expect(badEnumRes.error).toContain("must be one of");

    // Valid alert
    const validAlert = {
      patient_id: "pharmacy:ph-1",
      source_id: "stock:ph-1:Amoxicillin",
      severity: "CRITICAL" as const,
      title: "Critical Low Stock: Amoxicillin",
      summary: "Units remaining: 5, threshold: 20",
      jev_probabilities: { action: { alert: 0.95 } },
      audit_id: "aud-1",
      idem_key: "pharmacy:stock:ph-1:Amoxicillin:2026-11-13:alert",
    };
    const validRes = await pharmacyAlertTool.run(validAlert, mockBackend);
    expect(validRes.ok).toBe(true);
    expect(backendCalls[0].method).toBe("POST");
    expect(backendCalls[0].path).toBe("/api/alerts/agent");
    expect(backendCalls[0].body).toEqual(validAlert);

    // postPharmacyAlert helper
    await postPharmacyAlert(mockBackend, validAlert);
    expect(backendCalls[1].method).toBe("POST");
    expect(backendCalls[1].path).toBe("/api/alerts/agent");
  });
});

describe("Pharmacy Workflow - Execution & Gating", () => {
  let backendCalls: Array<{ method: string; path: string; body?: unknown }>;
  let mockBackend: any;
  let rpcData: any;
  let store: McStore;
  let audit: Audit;
  let state: AgentState;
  let gate: Gate;
  let policyStore: any;
  const fixedNow = new Date("2026-11-13T10:00:00.000Z");

  beforeEach(() => {
    backendCalls = [];
    mockBackend = {
      call: vi.fn(async (method: string, path: string, body?: unknown) => {
        backendCalls.push({ method, path, body });
        if (path === "/api/pharmacy/agent/stock-low") {
          return {
            ok: true,
            status: 200,
            data: {
              items: [
                {
                  pharmacyId: "ph-101",
                  drug: "Amoxicillin",
                  strength: "500mg",
                  quantity: 3,
                  lowStockThreshold: 25,
                },
              ],
            },
          };
        }
        if (path === "/api/pharmacy/agent/stuck-orders") {
          return {
            ok: true,
            status: 200,
            data: {
              items: [
                {
                  orderId: "ord-888",
                  pharmacyId: "ph-101",
                  patientId: "pat-999",
                  status: "preparing",
                  hoursInCurrentState: 5,
                  fulfilment: "delivery",
                },
              ],
            },
          };
        }
        if (path === "/api/pharmacy/agent/refill-suggestion") {
          return { ok: true, status: 201, data: { suggestionId: "sug-777" } };
        }
        if (path === "/api/alerts/agent") {
          return { ok: true, status: 201, data: { alertId: "alt-555" } };
        }
        return { ok: false, status: 404, error: "not found", retryable: false };
      }),
    };

    const { rpc } = fakeRpc();
    rpcData = rpc;
    store = new McStore(rpc);
    audit = new Audit(store);
    state = new AgentState(store);

    policyStore = {
      current: () => ({
        threshold: 0.9,
        groups: { pharmacy: "auto" },
        rateLimitPerMinute: 30,
      }),
    };
    gate = new Gate(policyStore);
  });

  it("handles low stock: Gemini builds facts, Jev decides alert, Gate executes, audits all steps", async () => {
    const jev = makeJev("alert", 2, 0.95);
    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const res = await wf.handleStockItem({
      pharmacyId: "ph-101",
      drug: "Amoxicillin",
      strength: "500mg",
      quantity: 3,
      lowStockThreshold: 25,
    }, fixedNow);

    expect(res.outcome).toBe("executed");
    expect(res.reason).toBe("ok");

    // Check alert dispatched
    const alertCall = backendCalls.find((c) => c.path === "/api/alerts/agent");
    expect(alertCall).toBeDefined();
    expect(alertCall?.body).toMatchObject({
      patient_id: "pharmacy:ph-101",
      source_id: "stock:ph-101:Amoxicillin",
      severity: "CRITICAL",
    });

    // Check audits
    const audits = await audit.list();
    expect(audits).toHaveLength(1);
    const auditDoc = audits[0];
    expect(auditDoc.outcome).toBe("executed");
    const kinds = auditDoc.steps.map((s: any) => s.kind);
    expect(kinds).toContain("state");
    expect(kinds).toContain("jev");
    expect(kinds).toContain("gate");
    expect(kinds).toContain("tool");

    // Idempotency: second call on same day is blocked as duplicate
    const secondRes = await wf.handleStockItem({
      pharmacyId: "ph-101",
      drug: "Amoxicillin",
      strength: "500mg",
      quantity: 3,
      lowStockThreshold: 25,
    }, fixedNow);
    expect(secondRes.outcome).toBe("blocked");
    expect(secondRes.reason).toBe("duplicate");
  });

  it("skips stock alert when Jev decides ignore", async () => {
    const jev = makeJev("ignore", 0, 0.95);
    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const res = await wf.handleStockItem({
      pharmacyId: "ph-101",
      drug: "Amoxicillin",
      strength: "500mg",
      quantity: 24,
      lowStockThreshold: 25,
    }, fixedNow);

    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("jev_ignore");
    expect(backendCalls.some((c) => c.path === "/api/alerts/agent")).toBe(false);
  });

  it("handles stuck order: Gemini facts, Jev alert, Gate checks, executes alert", async () => {
    const jev = makeJev("alert", 1, 0.95); // score 1 -> HIGH
    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const res = await wf.handleStuckOrder({
      orderId: "ord-888",
      pharmacyId: "ph-101",
      patientId: "pat-999",
      status: "preparing",
      hoursInCurrentState: 5,
    }, fixedNow);

    expect(res.outcome).toBe("executed");
    const alertCall = backendCalls.find((c) => c.path === "/api/alerts/agent");
    expect(alertCall).toBeDefined();
    expect(alertCall?.body).toMatchObject({
      patient_id: "pat-999",
      source_id: "order:ord-888",
      severity: "HIGH",
    });

    // Idempotency check
    const second = await wf.handleStuckOrder({
      orderId: "ord-888",
      pharmacyId: "ph-101",
      patientId: "pat-999",
      status: "preparing",
      hoursInCurrentState: 5,
    }, fixedNow);
    expect(second.outcome).toBe("blocked");
    expect(second.reason).toBe("duplicate");
  });

  it("handles missed-dose refill suggestion: submits suggestion for clinician, never prescription or order", async () => {
    const jev = makeJev("suggest_refill", 1, 0.95);
    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const res = await wf.handleMissedDoseRefill({
      reminderId: "rem-101",
      patientId: "pat-202",
      medicationName: "Atorvastatin",
      dosage: "20mg",
      pillsLeft: 0,
      refillsRemaining: 0,
      hasActiveOrder: false,
      date: "2026-11-13",
      time: "08:00",
    }, fixedNow);

    expect(res.outcome).toBe("executed");
    expect(res.reason).toBe("ok");

    const refillCall = backendCalls.find((c) => c.path === "/api/pharmacy/agent/refill-suggestion");
    expect(refillCall).toBeDefined();
    expect(refillCall?.body).toMatchObject({
      patientId: "pat-202",
      reminderId: "rem-101",
      medicationName: "Atorvastatin",
      dosage: "20mg",
      suggestedAction: "refill_suggestion",
    });

    // Verify it NEVER called /api/prescriptions or /api/patient-app/:patientId/orders
    expect(backendCalls.some((c) => c.path.includes("prescriptions"))).toBe(false);
    expect(backendCalls.some((c) => c.path.includes("patient-app") && c.path.includes("orders"))).toBe(false);

    // Idempotency: second run same day is blocked
    const dup = await wf.handleMissedDoseRefill({
      reminderId: "rem-101",
      patientId: "pat-202",
      medicationName: "Atorvastatin",
      dosage: "20mg",
      pillsLeft: 0,
      refillsRemaining: 0,
      hasActiveOrder: false,
    }, fixedNow);
    expect(dup.outcome).toBe("blocked");
    expect(dup.reason).toBe("duplicate");
  });

  it("checkAll evaluates stock-low, stuck-orders, and missed doses with exhausted refills", async () => {
    // Seed reminder in store
    await store.insert("reminders", {
      _id: "rem-missed-1",
      patientId: "pat-303",
      medicationName: "Metformin",
      dosage: "500mg",
      frequency: "daily",
      times: ["08:00"],
      active: true,
      pillsLeft: 0,
      createdAt: "2026-11-01T00:00:00.000Z",
      doseLog: [],
    });

    const jev = makeJev("alert", 2, 0.95);
    // Custom jev answering alert for stock/order and suggest_refill for refill
    jev.decide = vi.fn(async (_facts, questions) => {
      if (questions === REFILL_SUGGESTION_JEV_QUESTIONS) {
        return {
          answers: {
            action: { choice: "suggest_refill", probabilities: { suggest_refill: 0.95 } },
            urgency: { score: 1, probabilities: { urgent: 0.9 } },
            act_now: { noul: 0.95 },
          },
          fallback: false,
        };
      }
      return {
        answers: {
          action: { choice: "alert", probabilities: { alert: 0.95 } },
          urgency: { score: 2, probabilities: { critical: 0.9 } },
          act_now: { noul: 0.95 },
        },
        fallback: false,
      };
    });

    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const summary = await wf.checkAll(fixedNow);
    expect(summary.stockChecked).toBe(1);
    expect(summary.ordersChecked).toBe(1);
    expect(summary.refillsChecked).toBe(1);
    expect(summary.results.every((r) => r.outcome === "executed")).toBe(true);
  });

  it("kill-switch awareness: blocks and enqueues events when stopped, then retryPending drains and processes", async () => {
    await state.setStopped(true);

    const jev = makeJev("alert", 2, 0.95);
    const llm = makeLlm();
    const wf = new PharmacyWorkflow({
      jev,
      llm,
      audit,
      state,
      gate,
      backend: mockBackend,
      store,
      now: () => fixedNow,
    });

    const res = await wf.handleStockItem({
      pharmacyId: "ph-stop",
      drug: "Ciprofloxacin",
      strength: "250mg",
      quantity: 2,
      lowStockThreshold: 10,
    }, fixedNow);

    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("stopped");
    expect(backendCalls.some((c) => c.path === "/api/alerts/agent")).toBe(false);

    // Event was queued
    const queued = await state.drain();
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe("pharmacy.stock_low");

    // Put it back in queue to test retryPending
    await state.enqueue(queued[0]);

    // Unstop state and run retryPending
    await state.setStopped(false);
    const retriedCount = await wf.retryPending();
    expect(retriedCount).toBe(1);

    // Alert was sent on retry
    const alertCall = backendCalls.find((c) => c.path === "/api/alerts/agent");
    expect(alertCall).toBeDefined();
    expect(alertCall?.body).toMatchObject({
      patient_id: "pharmacy:ph-stop",
      source_id: "stock:ph-stop:Ciprofloxacin",
    });
  });

  it("periodic timer runs on start and cleans up on stopPeriodic", async () => {
    vi.useFakeTimers();
    try {
      const jev = makeJev("alert", 1, 0.95);
      const llm = makeLlm();
      const wf = registerPharmacyWorkflow({
        jev,
        llm,
        audit,
        state,
        gate,
        backend: mockBackend,
        store,
        now: () => fixedNow,
      });

      // Initial check was triggered
      expect(mockBackend.call).toHaveBeenCalledWith("GET", "/api/pharmacy/agent/stock-low");

      // Advance by 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(mockBackend.call).toHaveBeenCalledTimes(6); // initial (2 queries + 2 alerts), periodic (2 queries, alerts blocked by idempotency)

      wf.stopPeriodic();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockBackend.call).toHaveBeenCalledTimes(6); // no more calls after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
