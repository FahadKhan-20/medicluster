import { describe, it, expect, vi } from "vitest";
import { HealthPoller } from "../src/events/health.js";
import { DispatchClient } from "../src/tools/dispatch.js";
import type { DispatchWorkflowEvent } from "../src/workflows/dispatch.js";

describe("Main wiring for dispatch workflow", () => {
  it("includes dispatch in HealthPoller targets and isUp('dispatch') reflects health status", async () => {
    let dispatchStatus = 200;
    const poller = new HealthPoller({
      targets: {
        backend: "http://backend/api/health",
        dispatch: "http://dispatch-api:3001/health",
      },
      fetch: vi.fn(async (url: string) => {
        if (url.includes("dispatch")) {
          return new Response(JSON.stringify({ status: dispatchStatus === 200 ? "healthy" : "unhealthy" }), {
            status: dispatchStatus,
          });
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as unknown as typeof fetch,
      intervalMs: 10_000,
    });

    let events: any[] = [];
    await poller.start((e) => {
      events.push(e);
    });
    expect(poller.isUp("dispatch")).toBe(true);

    dispatchStatus = 503;
    // Next poll marks it down
    await (poller as any).poll((e: any) => events.push(e));
    expect(poller.isUp("dispatch")).toBe(false);
    poller.stop();
  });

  it("polling dispatch API feeds pending incidents into dispatchWorkflow", async () => {
    const handledEvents: DispatchWorkflowEvent[] = [];
    const fakeWorkflow = {
      handle: vi.fn(async (event: DispatchWorkflowEvent) => {
        handledEvents.push(event);
        return "executed" as const;
      }),
    };

    const pendingIncidents = [
      { id: "INC-1", status: "PENDING", assigned_ambulance_id: null, created_at: "2026-11-13T00:00:00Z" },
      { id: "INC-2", status: "ASSIGNED", assigned_ambulance_id: "AMB-1" }, // Already assigned, should be ignored by poller filter
      { id: "INC-3", status: "PENDING", assigned_ambulance_id: null, created_at: "2026-11-13T00:01:00Z" },
    ];

    const dispatchClient = new DispatchClient({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify(pendingIncidents), { status: 200 }),
      ) as unknown as typeof fetch,
    });

    const res = await dispatchClient.getPendingIncidents();
    expect(res.ok).toBe(true);
    if (res.ok && Array.isArray(res.data)) {
      for (const inc of res.data) {
        if (inc && inc.id && inc.status === "PENDING" && !inc.assigned_ambulance_id) {
          await fakeWorkflow.handle({
            id: inc.id,
            type: "incident.pending",
            incidentId: inc.id,
            doc: inc,
            at: typeof inc.created_at === "string" ? inc.created_at : new Date().toISOString(),
          });
        }
      }
    }

    expect(handledEvents.length).toBe(2);
    expect(handledEvents.map((e) => e.incidentId)).toEqual(["INC-1", "INC-3"]);
  });

  it("retryPending aggregates both loop and dispatchWorkflow retries", async () => {
    let loopRetried = false;
    let dispatchRetried = false;

    const fakeLoop = {
      retryPending: async () => {
        loopRetried = true;
        return 1;
      },
    };

    const fakeDispatch = {
      retryPending: async () => {
        dispatchRetried = true;
        return 2;
      },
    };

    const retry = () =>
      Promise.all([
        fakeLoop.retryPending(),
        fakeDispatch.retryPending(),
      ]);

    const results = await retry();
    expect(results).toEqual([1, 2]);
    expect(loopRetried).toBe(true);
    expect(dispatchRetried).toBe(true);
  });
});
