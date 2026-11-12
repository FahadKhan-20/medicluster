import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/api/server.js";
import {
  escapeHtml,
  truncateString,
  truncateDeep,
  formatJsonSafe,
  renderReplayStep,
  REPLAY_STEP_NAMES,
} from "../src/console/index.js";

const ADMIN_KEY = "test-secret-replay-key";

describe("Decision Replay - API (GET /audit/:id)", () => {
  let server: http.Server;
  let base: string;
  let mockStoreFind: any;
  let mockAuditGet: any;

  beforeEach(async () => {
    mockStoreFind = vi.fn(async (collection: string, filter: any) => {
      if (collection === "agent_audit" && filter._id === "valid-audit-123") {
        return [
          {
            _id: "valid-audit-123",
            event: { type: "scan.analyzed", mediaId: "med-1" },
            steps: [
              { kind: "state", data: { finding: "infiltrate" } },
              {
                kind: "jev",
                data: {
                  answers: {
                    action: { choice: "alert", probabilities: { alert: 0.85, ignore: 0.15 } },
                    act_now: { noul: 0.96 },
                  },
                },
              },
              {
                kind: "gate",
                data: { verdict: "execute", reason: "Meets threshold", level: "auto", threshold: 0.9 },
              },
              {
                kind: "tool",
                data: {
                  tool: "alerts.create",
                  args: { priority: "high" },
                  result: { ok: true, status: 200, duration: 42 },
                },
              },
            ],
            outcome: "executed",
            reason: "Workflow completed",
            startedAt: "2026-11-13T01:00:00.000Z",
            finishedAt: "2026-11-13T01:00:01.000Z",
          },
        ];
      }
      return [];
    });

    const audit = {
      list: vi.fn(async () => []),
    };

    const state = {
      isStopped: async () => false,
      setStopped: async () => {},
    } as any;

    const loop = {
      handle: vi.fn(async () => "executed"),
      retryPending: vi.fn(async () => 0),
    } as any;

    const health = { isUp: () => true } as any;

    server = createServer({
      audit: audit as any,
      state,
      loop,
      health,
      store: { find: mockStoreFind } as any,
      adminKey: ADMIN_KEY,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("requires admin key (401 when missing)", async () => {
    const res = await fetch(`${base}/audit/valid-audit-123`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects invalid admin key (401)", async () => {
    for (const badKey of ["wrong-key", "", "bearer foo", ADMIN_KEY + "-extra"]) {
      const res = await fetch(`${base}/audit/valid-audit-123`, {
        headers: { "x-admin-key": badKey },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("validates audit id format (400 for invalid characters or empty)", async () => {
    const invalidIds = [
      "",
      "bad$id",
      "audit/slash",
      "audit.dot",
      "audit@special",
      "audit<script>",
      "id with space",
      "a".repeat(129), // exceeds 128 chars limit
    ];

    for (const id of invalidIds) {
      const res = await fetch(`${base}/audit/${id}`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid audit id" });
    }
  });

  it("returns 404 when valid audit id is not found in store", async () => {
    const res = await fetch(`${base}/audit/missing-audit-999`, {
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Audit not found" });
    expect(mockStoreFind).toHaveBeenCalledWith("agent_audit", { _id: "missing-audit-999" }, undefined, 1);
  });

  it("returns 200 with audit document when found via store.find", async () => {
    const res = await fetch(`${base}/audit/valid-audit-123`, {
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc._id).toBe("valid-audit-123");
    expect(doc.event.type).toBe("scan.analyzed");
    expect(doc.outcome).toBe("executed");
    expect(doc.steps).toHaveLength(4);
  });

  it("supports audit.get if provided in dependencies", async () => {
    const customAuditDoc = { _id: "custom-id-456", outcome: "review" };
    mockAuditGet = vi.fn(async (id: string) => (id === "custom-id-456" ? customAuditDoc : null));

    const s = createServer({
      audit: { list: vi.fn(), get: mockAuditGet } as any,
      state: { isStopped: async () => false, setStopped: async () => {} } as any,
      loop: {} as any,
      health: { isUp: () => true } as any,
      store: { find: vi.fn() } as any,
      adminKey: ADMIN_KEY,
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const customBase = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

    try {
      const res = await fetch(`${customBase}/audit/custom-id-456`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(customAuditDoc);
      expect(mockAuditGet).toHaveBeenCalledWith("custom-id-456");

      const notFoundRes = await fetch(`${customBase}/audit/custom-missing`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      expect(notFoundRes.status).toBe(404);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});

describe("Decision Replay - HTML Sanitization & Truncation", () => {
  it("escapeHtml replaces HTML special characters", () => {
    expect(escapeHtml("hello & world")).toBe("hello &amp; world");
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
    );
    expect(escapeHtml('foo "bar" <baz>')).toBe("foo &quot;bar&quot; &lt;baz&gt;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(12345)).toBe("12345");
  });

  it("truncateString preserves strings <= 500 characters", () => {
    const shortStr = "A".repeat(500);
    expect(truncateString(shortStr)).toBe(shortStr);
    expect(truncateString("short string")).toBe("short string");
    expect(truncateString(null)).toBe("");
  });

  it("truncateString truncates strings > 500 characters with indicator", () => {
    const longStr = "B".repeat(600);
    const truncated = truncateString(longStr, 500);
    expect(truncated.startsWith("B".repeat(500))).toBe(true);
    expect(truncated).toContain("… [truncated to 500 chars]");
    expect(truncated.length).toBe(500 + "… [truncated to 500 chars]".length);
  });

  it("truncateDeep recursively truncates strings inside arrays and objects", () => {
    const deepObj = {
      short: "hello",
      num: 42,
      bool: true,
      long: "C".repeat(600),
      nested: {
        innerLong: "D".repeat(700),
        arr: ["E".repeat(550), "normal"],
      },
    };

    const res = truncateDeep(deepObj, 500) as any;
    expect(res.short).toBe("hello");
    expect(res.num).toBe(42);
    expect(res.bool).toBe(true);
    expect(res.long).toContain("… [truncated to 500 chars]");
    expect(res.nested.innerLong).toContain("… [truncated to 500 chars]");
    expect(res.nested.arr[0]).toContain("… [truncated to 500 chars]");
    expect(res.nested.arr[1]).toBe("normal");
  });

  it("formatJsonSafe produces truncated and HTML-escaped JSON", () => {
    const maliciousPayload = {
      attack: "<script>alert(document.cookie)</script>",
      largeArg: "X".repeat(600),
    };

    const formatted = formatJsonSafe(maliciousPayload, 500);
    expect(formatted).not.toContain("<script>");
    expect(formatted).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
    expect(formatted).toContain("… [truncated to 500 chars]");
  });

  it("REPLAY_STEP_NAMES exports 6 canonical step names", () => {
    expect(REPLAY_STEP_NAMES).toHaveLength(6);
    expect(REPLAY_STEP_NAMES).toEqual([
      "Event",
      "Gemini State",
      "Jev Decision",
      "Gate Result",
      "Tool Calls",
      "Outcome",
    ]);
  });
});

describe("Decision Replay - renderReplayStep across all 6 stages with XSS attacks", () => {
  const xssProbe = `<script>alert('pwned')</script><img src=x onerror=alert(1)>" ' &`;

  it("Step 1 (Event): safely escapes event fields and raw payload", () => {
    const audit = {
      _id: "aud-xss",
      event: {
        type: xssProbe,
        mediaId: xssProbe,
        patientId: xssProbe,
        extraLarge: "E".repeat(700),
      },
      startedAt: "2026-11-13T00:00:00.000Z",
    };

    const html = renderReplayStep(1, audit);
    expect(html).toContain("Step 1 of 6");
    expect(html).not.toContain("<script>alert('pwned')</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("… [truncated to 500 chars]");
  });

  it("Step 2 (Gemini State): safely escapes extracted facts and truncates large values", () => {
    const audit = {
      steps: [
        {
          kind: "state",
          data: {
            [xssProbe]: xssProbe,
            largeFindings: "F".repeat(800),
          },
        },
      ],
    };

    const html = renderReplayStep(2, audit);
    expect(html).toContain("Step 2 of 6");
    expect(html).not.toContain("<script>alert('pwned')</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("… [truncated to 500 chars]");
  });

  it("Step 3 (Jev Decision): renders probabilities and flags fallback in red with error reason", () => {
    // Normal Jev step
    const auditNormal = {
      steps: [
        {
          kind: "jev",
          data: {
            answers: {
              action: {
                choice: "alert",
                probabilities: { alert: 0.8, ignore: 0.1, request_review: 0.1 },
              },
              urgency: {
                choice: "urgent",
                probabilities: { routine: 0.1, urgent: 0.9 },
              },
              act_now: { noul: 0.94 },
            },
          },
        },
      ],
    };

    const htmlNormal = renderReplayStep(3, auditNormal);
    expect(htmlNormal).toContain("Step 3 of 6");
    expect(htmlNormal).toContain("CHOSEN");
    expect(htmlNormal).toContain("80%");
    expect(htmlNormal).toContain("Noul Safety Score");
    expect(htmlNormal).toContain("0.940 (94%)");

    // Fallback Jev step with error & XSS
    const auditFallback = {
      steps: [
        {
          kind: "jev",
          data: {
            fallback: true,
            error: xssProbe,
            answers: {
              action: { choice: xssProbe, probabilities: { [xssProbe]: 1.0 } },
            },
          },
        },
      ],
    };

    const htmlFallback = renderReplayStep(3, auditFallback);
    expect(htmlFallback).toContain("replay-fallback-banner");
    expect(htmlFallback).toContain("Fallback Triggered");
    expect(htmlFallback).not.toContain("<script>alert('pwned')</script>");
    expect(htmlFallback).toContain("&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;");
  });

  it("Step 4 (Gate Result): renders level, threshold, verdict and escapes malicious reason", () => {
    const audit = {
      steps: [
        {
          kind: "gate",
          data: {
            verdict: "blocked",
            level: "strict",
            threshold: 0.95,
            reason: xssProbe + " " + "R".repeat(700),
          },
        },
      ],
    };

    const html = renderReplayStep(4, audit);
    expect(html).toContain("Step 4 of 6");
    expect(html).toContain("Safety Gate Verdict");
    expect(html).toContain("strict");
    expect(html).toContain("&ge; 0.95");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("… [truncated to 500 chars]");
  });

  it("Step 5 (Tool Calls): renders tool execution, args and status safely truncated", () => {
    const audit = {
      steps: [
        {
          kind: "tool",
          data: {
            tool: xssProbe,
            args: {
              param: xssProbe,
              largePayload: "P".repeat(900),
            },
            result: {
              ok: false,
              status: 500,
              duration: 120,
              error: xssProbe,
            },
          },
        },
      ],
    };

    const html = renderReplayStep(5, audit);
    expect(html).toContain("Step 5 of 6");
    expect(html).toContain("Tool Execution & Arguments");
    expect(html).toContain("120ms");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("… [truncated to 500 chars]");
  });

  it("Step 6 (Outcome): renders final outcome, score and escapes reason", () => {
    const audit = {
      outcome: "executed",
      reason: xssProbe + " " + "O".repeat(600),
      startedAt: "2026-11-13T01:00:00.000Z",
      finishedAt: "2026-11-13T01:00:02.500Z",
      steps: [{}, {}, {}],
    };

    const html = renderReplayStep(6, audit);
    expect(html).toContain("Step 6 of 6");
    expect(html).toContain("Final Decision Outcome");
    expect(html).toContain("2500ms");
    expect(html).toContain("3 steps");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("… [truncated to 500 chars]");
  });

  it("handles empty audit and invalid step numbers safely", () => {
    expect(renderReplayStep(1, null)).toContain("No audit data available");
    expect(renderReplayStep(99, { outcome: "executed" })).toContain("Invalid step index: 99");
  });
});
