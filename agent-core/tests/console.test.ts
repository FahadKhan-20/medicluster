import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/api/server.js";
import { getConsoleHtml } from "../src/console/index.js";

const ADMIN_KEY = "test-admin-key-secret";

let server: http.Server;
let base: string;
let stopped: boolean;

beforeEach(async () => {
  stopped = false;
  const state = {
    isStopped: async () => stopped,
    setStopped: async (b: boolean) => {
      stopped = b;
    },
  } as any;
  const loop = {
    handle: vi.fn(async () => "executed"),
    retryPending: vi.fn(async () => 0),
  } as any;
  const audit = {
    list: vi.fn(async () => [
      {
        _id: "audit-1",
        event: { type: "scan.analyzed", mediaId: "m1" },
        steps: [
          {
            kind: "jev",
            data: {
              answers: {
                action: { choice: "alert", probabilities: { analyze: 0.1, alert: 0.8, request_review: 0.05, ignore: 0.05 } },
                urgency: { choice: "urgent", probabilities: { routine: 0.2, urgent: 0.7, critical: 0.1 } },
                act_now: { noul: 0.95 },
              },
            },
          },
        ],
        outcome: "executed",
        startedAt: "2026-11-13T00:00:00.000Z",
      },
    ]),
  } as any;
  const health = { isUp: (n: string) => n === "backend" || n === "intelligence" } as any;
  const store = {
    find: vi.fn(async () => [{ _id: "m1", analysis: { analyzedAt: "2026-11-13T00:00:00.000Z" } }]),
  } as any;

  server = createServer({ audit, state, loop, health, store, adminKey: ADMIN_KEY });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

describe("Console UI & API Security", () => {
  it("getConsoleHtml returns HTML string with expected components", () => {
    const html = getConsoleHtml();
    expect(typeof html).toBe("string");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("MediCluster Agent Command Center");
    expect(html).toContain("sessionStorage");
    expect(html).toContain("/audit");
    expect(html).toContain("/control/stop");
    expect(html).toContain("/control/start");
    expect(html).toContain("/command");
    expect(html).toContain("/health");
    expect(html).toContain("data-theme");
  });

  it("GET /console returns 200 html without admin key", async () => {
    const res = await fetch(`${base}/console`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("MediCluster Agent Command Center");
    expect(body).toContain("sessionStorage");
    expect(body).toContain("Live Audit Feed");
  });

  it("GET /console/ and /console/index.html also return 200 html", async () => {
    const res1 = await fetch(`${base}/console/`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/html");

    const res2 = await fetch(`${base}/console/index.html`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("content-type")).toContain("text/html");
  });

  it("data routes still return 401 without admin key", async () => {
    // GET /audit
    const auditRes = await fetch(`${base}/audit`);
    expect(auditRes.status).toBe(401);
    expect(await auditRes.json()).toEqual({ error: "Unauthorized" });

    // POST /control/stop
    const stopRes = await fetch(`${base}/control/stop`, { method: "POST" });
    expect(stopRes.status).toBe(401);
    expect(await stopRes.json()).toEqual({ error: "Unauthorized" });

    // POST /control/start
    const startRes = await fetch(`${base}/control/start`, { method: "POST" });
    expect(startRes.status).toBe(401);
    expect(await startRes.json()).toEqual({ error: "Unauthorized" });

    // POST /command
    const cmdRes = await fetch(`${base}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "reprocess", mediaId: "m1" }),
    });
    expect(cmdRes.status).toBe(401);
    expect(await cmdRes.json()).toEqual({ error: "Unauthorized" });
  });

  it("data routes reject invalid admin keys", async () => {
    for (const badKey of ["wrong", "", "admin-key", ADMIN_KEY + "!"]) {
      const res = await fetch(`${base}/audit`, {
        headers: { "x-admin-key": badKey },
      });
      expect(res.status).toBe(401);
    }
  });

  it("data routes succeed with valid admin key", async () => {
    const headers = { "x-admin-key": ADMIN_KEY };

    // GET /audit
    const auditRes = await fetch(`${base}/audit`, { headers });
    expect(auditRes.status).toBe(200);
    const audits = await auditRes.json();
    expect(audits).toHaveLength(1);
    expect(audits[0]._id).toBe("audit-1");

    // POST /control/stop
    const stopRes = await fetch(`${base}/control/stop`, { method: "POST", headers });
    expect(stopRes.status).toBe(200);
    expect(await stopRes.json()).toEqual({ stopped: true });

    // POST /control/start
    const startRes = await fetch(`${base}/control/start`, { method: "POST", headers });
    expect(startRes.status).toBe(200);
    expect(await startRes.json()).toEqual({ stopped: false });

    // POST /command
    const cmdRes = await fetch(`${base}/command`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "reprocess", mediaId: "m1" }),
    });
    expect(cmdRes.status).toBe(200);
    expect(await cmdRes.json()).toEqual({ outcome: "executed" });
  });

  it("GET /health remains public and unauthenticated", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.services).toEqual({ backend: true, ml: false, intelligence: true });
  });
});
