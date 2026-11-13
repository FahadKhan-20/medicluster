import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/api/server.js";
import {
  deriveWorkflowStatus,
  computeWorkflowMetrics,
  getDefaultWorkflows,
  type WorkflowDescriptor,
} from "../src/workflows/registry.js";
import { renderWorkflowRow, renderWorkflowList } from "../src/console/render.js";

const ADMIN_KEY = "super-secret-admin-key";

describe("Workflows & /agents API", () => {
  let server: http.Server;
  let base: string;
  let stopped = false;

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
    const now = Date.now();
    const auditsList = [
      {
        _id: "audit-scan-1",
        event: { type: "scan.analyzed" },
        outcome: "executed",
        startedAt: new Date(now - 30 * 60 * 1000).toISOString(),
      },
      {
        _id: "audit-scan-2",
        event: { type: "scan.uploaded" },
        outcome: "blocked",
        startedAt: new Date(now - 60 * 60 * 1000).toISOString(),
      },
      {
        _id: "audit-scan-old",
        event: { type: "scan.analyzed" },
        outcome: "executed",
        startedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      },
      {
        _id: "audit-rx-1",
        event: { type: "pharmacy.stock_low" },
        outcome: "review",
        startedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      },
      {
        _id: "audit-ecg-1",
        event: { type: "ecg.analyzed" },
        outcome: "failed",
        startedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      },
    ];
    const audit = {
      list: vi.fn(async () => auditsList),
    } as any;
    const health = {
      isUp: (n: string) => n === "backend" || n === "ml",
    } as any;
    const store = {
      find: vi.fn(async () => []),
    } as any;
    const policyStore = {
      current: () => ({
        threshold: 0.9,
        groups: {
          imaging: "auto",
          radar: "off",
          pharmacy: "auto",
        },
        rateLimitPerMinute: 30,
      }),
    };

    server = createServer({
      audit,
      state,
      loop,
      health,
      store,
      adminKey: ADMIN_KEY,
      policyStore,
      workflows: getDefaultWorkflows(),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  describe("GET /agents authentication", () => {
    it("rejects request without admin key with 401", async () => {
      const res = await fetch(`${base}/agents`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("rejects request with invalid admin key with 401", async () => {
      const res = await fetch(`${base}/agents`, {
        headers: { "x-admin-key": "wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 and list of workflows with valid admin key", async () => {
      const res = await fetch(`${base}/agents`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(10);

      // Verify Pharmacy Ops is present
      const pharmacy = list.find((w: any) => w.id === "pharmacy");
      expect(pharmacy).toBeDefined();
      expect(pharmacy.name).toBe("Pharmacy Ops");
      expect(pharmacy.group).toBe("pharmacy");
      expect(pharmacy.registered).toBe(true);

      // Verify fields required by spec
      const imaging = list.find((w: any) => w.id === "imaging");
      expect(imaging).toBeDefined();
      expect(imaging.id).toBe("imaging");
      expect(imaging.name).toBe("Imaging Scan Loop");
      expect(imaging.policyLevel).toBe("auto");
      expect(imaging.registered).toBe(true);
      expect(imaging.deps).toEqual({ backend: true, ml: true });
      expect(imaging.status).toBe("active");
      expect(imaging.counts24h.executed).toBe(1);
      expect(imaging.counts24h.blocked).toBe(1);
      expect(imaging.lastEventAt).toBeDefined();
      expect(imaging.lastOutcome).toBe("executed");
    });
  });

  describe("Status Derivation", () => {
    const mockHealth = (upServices: string[]) => ({
      isUp: (name: string) => upServices.includes(name),
    });

    it("returns 'active' when registered, deps are up, and not stopped", () => {
      const wf: WorkflowDescriptor = {
        id: "test",
        name: "Test Workflow",
        description: "Test",
        group: "test",
        prefixes: ["test."],
        deps: ["backend", "ml"],
        registered: true,
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "auto",
        isStopped: false,
        health: mockHealth(["backend", "ml"]),
      });
      expect(result.status).toBe("active");
      expect(result.reason).toBeNull();
    });

    it("returns 'degraded' when a dependent service is down", () => {
      const wf: WorkflowDescriptor = {
        id: "test",
        name: "Test Workflow",
        description: "Test",
        group: "test",
        prefixes: ["test."],
        deps: ["backend", "ml"],
        registered: true,
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "auto",
        isStopped: false,
        health: mockHealth(["backend"]), // ml is down
      });
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("ml");
    });

    it("returns 'paused' when kill switch is activated", () => {
      const wf: WorkflowDescriptor = {
        id: "test",
        name: "Test Workflow",
        description: "Test",
        group: "test",
        prefixes: ["test."],
        deps: ["backend"],
        registered: true,
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "auto",
        isStopped: true,
        health: mockHealth(["backend"]),
      });
      expect(result.status).toBe("paused");
      expect(result.reason).toContain("Kill switch");
    });

    it("returns 'off' when policy level is off", () => {
      const wf: WorkflowDescriptor = {
        id: "test",
        name: "Test Workflow",
        description: "Test",
        group: "test",
        prefixes: ["test."],
        deps: ["backend"],
        registered: true,
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "off",
        isStopped: false,
        health: mockHealth(["backend"]),
      });
      expect(result.status).toBe("off");
      expect(result.reason).toContain("Policy disabled");
    });

    it("returns 'not configured' when registered is false", () => {
      const wf: WorkflowDescriptor = {
        id: "test",
        name: "Test Workflow",
        description: "Test",
        group: "test",
        prefixes: ["test."],
        registered: false,
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "auto",
        isStopped: false,
        health: mockHealth(["backend"]),
      });
      expect(result.status).toBe("not configured");
      expect(result.reason).toContain("not registered");
    });

    it("returns 'not configured' when checkConfig fails with reason", () => {
      const wf: WorkflowDescriptor = {
        id: "dispatch",
        name: "Ambulance Dispatch",
        description: "Emergency dispatch",
        group: "dispatch",
        prefixes: ["incident."],
        registered: true,
        checkConfig: () => "Missing DISPATCH_URL environment variable. Set DISPATCH_URL=http://dispatch-api:3001 to enable.",
      };

      const result = deriveWorkflowStatus(wf, {
        policyLevel: "suggest",
        isStopped: false,
        health: mockHealth(["dispatch"]),
      });
      expect(result.status).toBe("not configured");
      expect(result.reason).toContain("Missing DISPATCH_URL");
    });
  });

  describe("Audit Metrics Computation", () => {
    it("computes counts for last 24 hours and identifies most recent event", () => {
      const wf: WorkflowDescriptor = {
        id: "imaging",
        name: "Imaging Scan Loop",
        description: "Scan processing",
        group: "imaging",
        prefixes: ["scan."],
      };

      const now = 1700000000000;
      const audits = [
        {
          event: { type: "scan.analyzed" },
          outcome: "executed",
          finishedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
        },
        {
          event: { type: "scan.analyzed" },
          outcome: "review",
          finishedAt: new Date(now - 1 * 3600 * 1000).toISOString(),
        },
        {
          event: { type: "scan.uploaded" },
          outcome: "blocked",
          finishedAt: new Date(now - 10 * 3600 * 1000).toISOString(),
        },
        {
          event: { type: "scan.failed" },
          outcome: "failed",
          finishedAt: new Date(now - 12 * 3600 * 1000).toISOString(),
        },
        // Older than 24h: should be excluded from counts24h
        {
          event: { type: "scan.analyzed" },
          outcome: "executed",
          finishedAt: new Date(now - 30 * 3600 * 1000).toISOString(),
        },
        // Unrelated event: should be completely ignored
        {
          event: { type: "incident.pending" },
          outcome: "executed",
          finishedAt: new Date(now - 1 * 3600 * 1000).toISOString(),
        },
      ];

      const metrics = computeWorkflowMetrics(wf, audits, now);
      expect(metrics.counts24h.executed).toBe(1);
      expect(metrics.counts24h.review).toBe(1);
      expect(metrics.counts24h.blocked).toBe(1);
      expect(metrics.counts24h.failed).toBe(1);
      // Most recent was scan.analyzed at 1 hour ago
      expect(metrics.lastEventAt).toBe(new Date(now - 1 * 3600 * 1000).toISOString());
      expect(metrics.lastOutcome).toBe("review");
    });
  });

  describe("Console HTML Rendering & XSS Protection", () => {
    it("escapes malicious names, descriptions and reasons", () => {
      const maliciousWf = {
        id: "xss-test",
        name: "<script>alert('pwned')</script>",
        description: "<img src=x onerror=alert(1)>",
        status: "active",
        policyLevel: "<script>hack</script>",
        reason: "<b>dangerous</b>",
        deps: { "evil<dep>": true },
        counts24h: { executed: 5 },
      };

      const html = renderWorkflowRow(maliciousWf);
      expect(html).not.toContain("<script>alert('pwned')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toContain("<b>dangerous</b>");
      expect(html).toContain("&lt;b&gt;dangerous&lt;/b&gt;");
      expect(html).toContain("evil&lt;dep&gt;");
    });

    it("renderWorkflowList renders all workflows or an empty state", () => {
      expect(renderWorkflowList([])).toContain("No workflows registered");

      const workflows = [
        { id: "wf1", name: "Alpha", status: "active", deps: { backend: true } },
        { id: "wf2", name: "Beta", status: "degraded", deps: { ml: false } },
      ];
      const html = renderWorkflowList(workflows);
      expect(html).toContain("Alpha");
      expect(html).toContain("Beta");
      expect(html).toContain("agents-table-box");
    });
  });
});
