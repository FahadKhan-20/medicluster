import { describe, it, expect, vi } from "vitest";
import {
  validatePatientId,
  generateSyntheticChestXrayPng,
  generateDeterioratingVitals,
  generateSyntheticEcg12Lead,
  generateSyntheticSosIncident,
  formatSummaryTable,
  pollAudit,
  runDemo,
  parseArgs,
  type DemoConfig,
  type StepResult,
} from "../scripts/demo.js";

describe("Demo Runner Unit Tests", () => {
  describe("1. DEMO- guard", () => {
    it("accepts patient IDs starting with DEMO-", () => {
      expect(() => validatePatientId("DEMO-P001")).not.toThrow();
      expect(() => validatePatientId("DEMO-TEST-99")).not.toThrow();
    });

    it("refuses non-demo patient IDs", () => {
      expect(() => validatePatientId("PATIENT-001")).toThrow(/\[SECURITY\] Refusing to run/);
      expect(() => validatePatientId("P001")).toThrow(/\[SECURITY\] Refusing to run/);
      expect(() => validatePatientId("12345")).toThrow(/\[SECURITY\] Refusing to run/);
      expect(() => validatePatientId("")).toThrow(/\[SECURITY\] Refusing to run/);
      expect(() => validatePatientId(null as any)).toThrow(/\[SECURITY\] Refusing to run/);
    });

    it("runDemo refuses immediately if patientId is invalid without calling fetch", async () => {
      const mockFetch = vi.fn();
      const config: DemoConfig = {
        backendUrl: "http://localhost:5000",
        dispatchUrl: "http://localhost:3001",
        agentUrl: "http://localhost:8100",
        agentAdminKey: "test-key",
        patientId: "LIVE-PATIENT-123",
        dryRun: false,
        timeoutSec: 1,
        fetchFn: mockFetch as any,
      };

      await expect(runDemo(config)).rejects.toThrow(/\[SECURITY\] Refusing to run/);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("2. dry-run sends nothing", () => {
    it("executes all 5 steps in dry-run mode without invoking fetch", async () => {
      const mockFetch = vi.fn();
      const config: DemoConfig = {
        backendUrl: "http://localhost:5000",
        dispatchUrl: "http://localhost:3001",
        agentUrl: "http://localhost:8100",
        agentAdminKey: "test-key",
        patientId: "DEMO-P001",
        dryRun: true,
        timeoutSec: 5,
        fetchFn: mockFetch as any,
      };

      const result = await runDemo(config);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
      expect(result.results.length).toBe(5);
      for (const step of result.results) {
        expect(step.outcome).toBe("dry-run");
        expect(step.auditId).toBe("(dry-run)");
        expect(step.seconds).toBe(0.0);
      }
      expect(result.success).toBe(true);
    });

    it("executes only a filtered step in dry-run mode", async () => {
      const mockFetch = vi.fn();
      const config: DemoConfig = {
        backendUrl: "http://localhost:5000",
        dispatchUrl: "http://localhost:3001",
        agentUrl: "http://localhost:8100",
        agentAdminKey: "test-key",
        patientId: "DEMO-P001",
        dryRun: true,
        onlyStep: 3,
        timeoutSec: 5,
        fetchFn: mockFetch as any,
      };

      const result = await runDemo(config);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.results.length).toBe(1);
      expect(result.results[0].step).toBe(3);
      expect(result.results[0].name).toBe("ECG");
    });
  });

  describe("3. timeout path returns 'timeout' not hang", () => {
    it("pollAudit returns outcome 'timeout' within timeoutMs when no audit entries appear", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [], // Empty audit list
      });

      const start = Date.now();
      const timeoutMs = 150; // fast test timeout
      const res = await pollAudit(
        "http://localhost:8100",
        "secret",
        new Date().toISOString(),
        timeoutMs,
        mockFetch as any,
        25 // fast poll interval
      );
      const elapsed = Date.now() - start;

      expect(res.outcome).toBe("timeout");
      expect(res.auditId).toBe("none");
      expect(res.durationSec).toBeGreaterThanOrEqual(0.1);
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(1000); // Definitely didn't hang
      expect(mockFetch).toHaveBeenCalled();
    });

    it("pollAudit handles network fetch errors gracefully and times out cleanly", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const start = Date.now();
      const res = await pollAudit(
        "http://localhost:8100",
        "secret",
        new Date().toISOString(),
        100,
        mockFetch as any,
        20
      );
      const elapsed = Date.now() - start;

      expect(res.outcome).toBe("timeout");
      expect(res.auditId).toBe("none");
      expect(elapsed).toBeLessThan(1000);
    });

    it("pollAudit returns immediately when an audit entry is returned", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            _id: "audit-12345678",
            outcome: "executed",
            startedAt: new Date().toISOString(),
          },
        ],
      });

      const start = Date.now();
      const res = await pollAudit(
        "http://localhost:8100",
        "secret",
        new Date().toISOString(),
        5000,
        mockFetch as any,
        50
      );
      const elapsed = Date.now() - start;

      expect(res.outcome).toBe("executed");
      expect(res.auditId).toBe("audit-12345678");
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("4. summary table", () => {
    it("formats summary table containing Step, Outcome, Audit ID, and Seconds", () => {
      const sampleResults: StepResult[] = [
        { step: 1, name: "Imaging", outcome: "executed", auditId: "aud-001", seconds: 1.2 },
        { step: 2, name: "Radar/Sepsis", outcome: "executed", auditId: "aud-002", seconds: 2.5 },
        { step: 3, name: "ECG", outcome: "review", auditId: "aud-003", seconds: 0.9 },
        { step: 4, name: "Dispatch", outcome: "executed", auditId: "aud-004", seconds: 1.1 },
        { step: 5, name: "Code Blue", outcome: "executed", auditId: "aud-005", seconds: 0.5 },
      ];

      const table = formatSummaryTable(sampleResults);

      expect(table).toContain("MEDICLUSTER DEMO RUN SUMMARY");
      expect(table).toContain("Step");
      expect(table).toContain("Outcome");
      expect(table).toContain("Audit ID");
      expect(table).toContain("Seconds");

      expect(table).toContain("1. Imaging");
      expect(table).toContain("executed");
      expect(table).toContain("aud-001");
      expect(table).toContain("1.2s");

      expect(table).toContain("2. Radar/Sepsis");
      expect(table).toContain("aud-002");
      expect(table).toContain("2.5s");

      expect(table).toContain("3. ECG");
      expect(table).toContain("review");

      expect(table).toContain("4. Dispatch");
      expect(table).toContain("5. Code Blue");
    });
  });

  describe("5. Synthetic generators & CLI options", () => {
    it("generates a valid 256x256 grayscale PNG with correct signature and chunks", () => {
      const png = generateSyntheticChestXrayPng(256, 256);
      expect(Buffer.isBuffer(png)).toBe(true);
      expect(png.length).toBeGreaterThan(100);

      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50); // P
      expect(png[2]).toBe(0x4e); // N
      expect(png[3]).toBe(0x47); // G
      expect(png[4]).toBe(0x0d);
      expect(png[5]).toBe(0x0a);
      expect(png[6]).toBe(0x1a);
      expect(png[7]).toBe(0x0a);

      // Contains IHDR, IDAT, IEND
      const hex = png.toString("binary");
      expect(hex).toContain("IHDR");
      expect(hex).toContain("IDAT");
      expect(hex).toContain("IEND");
    });

    it("generates 8 deteriorating vital readings with expected clinical patterns", () => {
      const vitals = generateDeterioratingVitals("DEMO-P001", 8);
      expect(vitals.length).toBe(8);

      // HR strictly rising
      for (let i = 1; i < vitals.length; i++) {
        expect(vitals[i].heart_rate).toBeGreaterThan(vitals[i - 1].heart_rate);
        expect(vitals[i].systolic_bp).toBeLessThan(vitals[i - 1].systolic_bp);
        expect(vitals[i].temperature).toBeGreaterThan(vitals[i - 1].temperature);
        expect(vitals[i].respiratory_rate).toBeGreaterThan(vitals[i - 1].respiratory_rate);
      }
      expect(vitals[0].heart_rate).toBe(80);
      expect(vitals[7].heart_rate).toBe(150);
      expect(vitals[0].systolic_bp).toBe(125);
      expect(vitals[7].systolic_bp).toBe(70);
    });

    it("generates a synthetic 10s 12-lead ECG with 12x1000 numeric signal array", () => {
      const ecg = generateSyntheticEcg12Lead("DEMO-P001");
      expect(ecg.patient_id).toBe("DEMO-P001");
      expect(ecg.lead_order.length).toBe(12);
      expect(ecg.signal.length).toBe(12);
      for (const lead of ecg.signal) {
        expect(lead.length).toBe(1000);
        for (const sample of lead) {
          expect(typeof sample).toBe("number");
          expect(Number.isFinite(sample)).toBe(true);
        }
      }
    });

    it("generates synthetic SOS incident with critical emergency payload", () => {
      const sos = generateSyntheticSosIncident("DEMO-P001");
      expect(sos.is_sos).toBe(true);
      expect(sos.severity).toBe("CRITICAL");
      expect(sos.description).toContain("DEMO-P001");
      expect(typeof sos.location_lat).toBe("number");
      expect(typeof sos.location_lng).toBe("number");
    });

    it("parses CLI flags correctly", () => {
      const opts1 = parseArgs(["--dry-run", "--patient", "DEMO-P999", "--only", "2", "--timeout", "45"]);
      expect(opts1.dryRun).toBe(true);
      expect(opts1.patientId).toBe("DEMO-P999");
      expect(opts1.onlyStep).toBe("2");
      expect(opts1.timeoutSec).toBe(45);

      const opts2 = parseArgs(["--only=imaging", "--patient=DEMO-P888", "--timeout=10"]);
      expect(opts2.onlyStep).toBe("imaging");
      expect(opts2.patientId).toBe("DEMO-P888");
      expect(opts2.timeoutSec).toBe(10);
    });
  });

  describe("6. Full mocked execution flow", () => {
    it("completes all 5 steps when backend, dispatch, and agent endpoints return success", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/auth/login")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: "fake-jwt-token" }),
          };
        }
        if (url.includes("/api/media/upload")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ _id: "media-demo-1" }),
          };
        }
        if (url.includes("/api/intelligence/radar/sessions")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "radar-session-demo-1" }),
          };
        }
        if (url.includes("/api/patient-app/")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ ok: true }),
          };
        }
        if (url.includes("/api/ecg/upload")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ record: { _id: "ecg-demo-1" } }),
          };
        }
        if (url.includes("/api/incidents")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "incident-demo-1" }),
          };
        }
        if (url.includes("/codeblue/start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: { id: "cb-sess-1" },
              card: {
                action: "Shock 200 J biphasic (or manufacturer dose)",
                status: "Suggested — clinician confirms",
                confidence: 0.95,
                supporting_agents: ["Intensivist", "Cardiologist"],
                rationale: "Ventricular fibrillation is a shockable rhythm",
              },
            }),
          };
        }
        if (url.includes("/audit")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                _id: "audit-mock-id",
                outcome: "executed",
                startedAt: new Date().toISOString(),
              },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      const config: DemoConfig = {
        backendUrl: "http://localhost:5000",
        dispatchUrl: "http://localhost:3001",
        agentUrl: "http://localhost:8100",
        agentAdminKey: "test-admin-key",
        staffEmail: "demo@medicluster.local",
        staffPassword: "demo-password-123",
        patientId: "DEMO-P001",
        dryRun: false,
        timeoutSec: 2,
        fetchFn: mockFetch as any,
      };

      const result = await runDemo(config);

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(5);
      for (const step of result.results) {
        expect(step.outcome).toBe("executed");
        expect(step.auditId).toBeTruthy();
      }
    });
  });
});
