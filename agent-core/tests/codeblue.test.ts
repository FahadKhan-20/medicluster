import { describe, it, expect } from "vitest";
import { fakeRpc } from "./helpers/fakeRpc.js";
import { McStore } from "../src/store/mc.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { Gate } from "../src/control/gate.js";
import type { PolicyStore } from "../src/control/policy.js";
import { FakeJev } from "../src/judge/jev.js";
import {
  CPR_CYCLE_SECONDS,
  SHOCK_DOSE_BIPHASIC,
  EPINEPHRINE_DOSE,
  AMIODARONE_FIRST_DOSE,
  AMIODARONE_SECOND_DOSE,
  isShockable,
} from "../src/codeblue/acls.js";
import { calculateEgfr } from "../src/codeblue/egfr.js";
import { checkDrugSafety } from "../src/codeblue/interactions.js";
import {
  IntensivistAgent,
  PharmacologistAgent,
  CardiologistAgent,
} from "../src/codeblue/specialists.js";
import { ConsensusEngine } from "../src/codeblue/consensus.js";
import { CodeBlueSimulator } from "../src/codeblue/simulator.js";
import { CodeBlueSession, CodeBlueEngine } from "../src/codeblue/session.js";
import { handleCodeBlueRoute } from "../src/codeblue/routes.js";
import type http from "node:http";

function setupDeps(jevRule?: (name: string, q: any) => any) {
  const { rpc, db } = fakeRpc();
  const store = new McStore(rpc);
  const audit = new Audit(store);
  const state = new AgentState(store);
  const policy: PolicyStore = {
    current: () => ({
      threshold: 0.9,
      groups: { clinical: "auto" },
      rateLimitPerMinute: 60,
    }),
    watch: () => {},
    close: () => {},
  };
  const gate = new Gate(policy);

  const jev = new FakeJev((name, q) => {
    if (jevRule) return jevRule(name, q);
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria ?? {});
      return {
        type: "choice",
        choice: keys[0],
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / (keys.length - 1 || 1)])),
        confidence: 0.95,
      };
    }
    return { type: "noul", noul: 0.95 };
  });

  return { store, audit, state, gate, jev, db };
}

describe("1. ACLS Rule Engine Timings & Rules", () => {
  const intensivist = new IntensivistAgent();

  it("recommends immediate defibrillation on initial shockable VF", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 10,
      cprElapsedSeconds: 10,
      cprCycle: 1,
      shockCount: 0,
      amiodaroneDosesGiven: 0,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: true,
    });

    expect(rec.action).toBe(SHOCK_DOSE_BIPHASIC);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.95);
    expect(isShockable("VF")).toBe(true);
  });

  it("prompts rhythm and pulse check at 2-minute CPR cycle completion", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 120,
      cprElapsedSeconds: 120, // 2-min boundary
      cprCycle: 1,
      shockCount: 1,
      amiodaroneDosesGiven: 0,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: false,
    });

    expect(rec.action).toContain("Pause CPR for Rhythm and Pulse Check");
    expect(rec.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it("holds Epinephrine during cycle 1 of shockable rhythm, but gives after 2nd shock", () => {
    // During cycle 1 (after 1st shock): continue CPR, no epi yet
    const rec1 = intensivist.evaluate({
      codeTimeSeconds: 30,
      cprElapsedSeconds: 30,
      cprCycle: 1,
      shockCount: 1,
      amiodaroneDosesGiven: 0,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: false,
    });
    expect(rec1.action).toContain("Continue High-Quality CPR");

    // After 2nd shock: Epinephrine indicated
    const rec2 = intensivist.evaluate({
      codeTimeSeconds: 140,
      cprElapsedSeconds: 20,
      cprCycle: 2,
      shockCount: 2,
      amiodaroneDosesGiven: 0,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: false,
    });
    expect(rec2.action).toContain(EPINEPHRINE_DOSE);
  });

  it("recommends Epinephrine ASAP from cycle 1 on non-shockable Asystole", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 15,
      cprElapsedSeconds: 15,
      cprCycle: 1,
      shockCount: 0,
      amiodaroneDosesGiven: 0,
      currentRhythm: "ASYSTOLE",
      hasPulse: false,
      shockPending: false,
    });
    expect(rec.action).toContain("Epinephrine 1 mg IV/IO ASAP");
    expect(rec.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("recommends Amiodarone 300 mg after 3rd shock in refractory VF", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 260,
      cprElapsedSeconds: 20,
      cprCycle: 3,
      shockCount: 3,
      lastEpiTimeSeconds: 140, // Epi was given at 140s, not due yet
      amiodaroneDosesGiven: 0,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: false,
    });
    expect(rec.action).toContain(AMIODARONE_FIRST_DOSE);
  });

  it("recommends Amiodarone 150 mg second dose after 5th shock", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 500,
      cprElapsedSeconds: 20,
      cprCycle: 5,
      shockCount: 5,
      lastEpiTimeSeconds: 400,
      amiodaroneDosesGiven: 1,
      currentRhythm: "VF",
      hasPulse: false,
      shockPending: false,
    });
    expect(rec.action).toContain(AMIODARONE_SECOND_DOSE);
  });

  it("recommends Post-Cardiac Arrest Care immediately upon ROSC", () => {
    const rec = intensivist.evaluate({
      codeTimeSeconds: 300,
      cprElapsedSeconds: 40,
      cprCycle: 3,
      shockCount: 2,
      amiodaroneDosesGiven: 0,
      currentRhythm: "ROSC",
      hasPulse: true,
      shockPending: false,
    });
    expect(rec.action).toContain("Initiate Post-Cardiac Arrest Care");
    expect(rec.confidence).toBeGreaterThanOrEqual(0.98);
  });
});

describe("2. eGFR via CKD-EPI 2021 Race-Free Equation", () => {
  it("computes normal eGFR for young female with normal creatinine", () => {
    // Female, 25yo, Scr = 0.6 mg/dL (Scr <= 0.7)
    const res = calculateEgfr(0.6, 25, "F");
    expect(res.egfr).toBeGreaterThanOrEqual(115);
    expect(res.stage).toBe("G1");
    expect(res.renalImpaired).toBe(false);
  });

  it("computes moderate renal impairment for 65yo female with elevated creatinine", () => {
    // Female, 65yo, Scr = 1.8 mg/dL (Scr > 0.7)
    const res = calculateEgfr(1.8, 65, "F");
    expect(res.egfr).toBeGreaterThanOrEqual(28);
    expect(res.egfr).toBeLessThanOrEqual(36);
    expect(res.stage).toBe("G3b");
    expect(res.renalImpaired).toBe(true);
  });

  it("computes normal eGFR for 50yo male with normal creatinine", () => {
    // Male, 50yo, Scr = 0.8 mg/dL (Scr <= 0.9)
    const res = calculateEgfr(0.8, 50, "M");
    expect(res.egfr).toBeGreaterThanOrEqual(95);
    expect(res.stage).toBe("G1");
  });

  it("computes severe kidney impairment for 70yo male with high creatinine", () => {
    // Male, 70yo, Scr = 3.5 mg/dL (Scr > 0.9)
    const res = calculateEgfr(3.5, 70, "M");
    expect(res.egfr).toBeLessThan(20);
    expect(res.severeImpairment).toBe(true);
    expect(["G4", "G5"]).toContain(res.stage);
  });

  it("throws on non-positive creatinine or age", () => {
    expect(() => calculateEgfr(0, 50, "M")).toThrow();
    expect(() => calculateEgfr(-1.2, 50, "M")).toThrow();
    expect(() => calculateEgfr(1.0, 0, "M")).toThrow();
  });
});

describe("3. Pharmacologist Allergy Veto and Drug Interactions", () => {
  const pharmacologist = new PharmacologistAgent();

  it("issues Pharmacologist Veto on documented iodine allergy for Amiodarone", () => {
    const patient = {
      patientId: "pt-allergy-1",
      ageYears: 60,
      sex: "M" as const,
      creatinineMgDl: 1.2,
      allergies: ["iodine", "penicillin"],
      currentMedications: ["atorvastatin"],
    };

    const rec = pharmacologist.evaluate(patient, "Administer Amiodarone 300 mg IV/IO bolus");
    expect(rec.veto).toBe(true);
    expect(rec.action).toContain("Veto: Substitute with Lidocaine");
    expect(rec.rationale).toContain("allergy to iodine");
    expect(rec.warnings.some((w) => w.toLowerCase().includes("iodine"))).toBe(true);
  });

  it("issues Pharmacologist Veto on direct amiodarone allergy", () => {
    const patient = {
      patientId: "pt-allergy-2",
      allergies: ["Amiodarone"],
    };
    const rec = pharmacologist.evaluate(patient, "Administer Amiodarone 300 mg IV/IO");
    expect(rec.veto).toBe(true);
    expect(rec.action).toContain("Lidocaine");
  });

  it("flags high warning for Epinephrine with non-selective beta-blockers", () => {
    const patient = {
      patientId: "pt-interaction-1",
      currentMedications: ["propranolol", "aspirin"],
      allergies: [],
    };
    const rec = pharmacologist.evaluate(patient, "Administer Epinephrine 1 mg IV/IO");
    expect(rec.veto).toBe(false);
    expect(rec.warnings.some((w) => w.includes("propranolol") && w.includes("HIGH"))).toBe(true);
  });

  it("flags QT prolongation warning for Amiodarone with ondansetron/haloperidol", () => {
    const patient = {
      patientId: "pt-interaction-2",
      currentMedications: ["ondansetron"],
      allergies: [],
    };
    const rec = pharmacologist.evaluate(patient, "Administer Amiodarone 300 mg IV/IO");
    expect(rec.veto).toBe(false);
    expect(rec.warnings.some((w) => w.toLowerCase().includes("qt prolongation"))).toBe(true);
  });
});

describe("4. Consensus Card Shape & 'Never Executes'", () => {
  it("builds Consensus Action Card with exact shape and status 'Suggested — clinician confirms'", async () => {
    const deps = setupDeps();
    const consensus = new ConsensusEngine();

    const intensivistRec = {
      agent: "Intensivist" as const,
      action: SHOCK_DOSE_BIPHASIC,
      rationale: "VF confirmed.",
      confidence: 0.98,
      warnings: [],
    };
    const pharmRec = {
      agent: "Pharmacologist" as const,
      action: SHOCK_DOSE_BIPHASIC,
      rationale: "No drug contraindications.",
      confidence: 0.95,
      warnings: [],
    };
    const cardioRec = {
      agent: "Cardiologist" as const,
      action: "Defibrillate Shockable Rhythm (VF)",
      rationale: "VF 88% probability.",
      confidence: 0.92,
      warnings: [],
    };

    const card = await consensus.resolve({
      sessionId: "session-test-1",
      patientId: "pt-100",
      intensivist: intensivistRec,
      pharmacologist: pharmRec,
      cardiologist: cardioRec,
      nextDueInSeconds: 110,
      jev: deps.jev,
      gate: deps.gate,
      audit: deps.audit,
      state: deps.state,
    });

    // Check strict card schema
    expect(card).toBeDefined();
    expect(card.sessionId).toBe("session-test-1");
    expect(card.action).toBe(SHOCK_DOSE_BIPHASIC);
    expect(card.status).toBe("Suggested — clinician confirms");
    expect(card.confidence).toBeGreaterThanOrEqual(0.8);
    expect(card.supporting_agents).toContain("Intensivist");
    expect(card.auditId).toBeDefined();

    // Verify card was audited into the store
    const auditLogs = await deps.audit.list();
    expect(auditLogs.length).toBeGreaterThan(0);
    const cardAudit = auditLogs.find((l) => (l.event as any).cardId === card.id);
    expect(cardAudit).toBeDefined();
    expect(cardAudit.outcome).toBe("review"); // Never auto-executed!
  });

  it("respects Pharmacologist Veto in consensus choice", async () => {
    const deps = setupDeps((name, q) => {
      // Jev selects the vetoed alternative
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria ?? {});
        return { type: "choice", choice: "veto_action", confidence: 0.96 };
      }
      return { type: "noul", noul: 0.95 };
    });
    const consensus = new ConsensusEngine();

    const intensivistRec = {
      agent: "Intensivist" as const,
      action: "Administer Amiodarone 300 mg IV/IO bolus",
      rationale: "Shockable refractory rhythm.",
      confidence: 0.93,
      warnings: [],
    };
    const pharmRec = {
      agent: "Pharmacologist" as const,
      action: "Veto: Substitute with Lidocaine 1.0–1.5 mg/kg IV/IO",
      rationale: "Documented iodine allergy.",
      confidence: 0.98,
      warnings: ["Allergy to iodine contraindicates Amiodarone."],
      veto: true,
    };
    const cardioRec = {
      agent: "Cardiologist" as const,
      action: "Defibrillate Shockable Rhythm",
      rationale: "VF.",
      confidence: 0.90,
      warnings: [],
    };

    const card = await consensus.resolve({
      sessionId: "session-veto-test",
      patientId: "pt-veto",
      intensivist: intensivistRec,
      pharmacologist: pharmRec,
      cardiologist: cardioRec,
      jev: deps.jev,
      gate: deps.gate,
      audit: deps.audit,
      state: deps.state,
    });

    expect(card.action).toContain("Lidocaine");
    expect(card.warnings.some((w) => w.includes("VETO"))).toBe(true);
    expect(card.status).toBe("Suggested — clinician confirms");
  });
});

describe("5. Session Engine & Clinician Ack & Simulator", () => {
  it("advances session timers and logs clinician acknowledgement", async () => {
    const deps = setupDeps();
    const engine = new CodeBlueEngine(deps);

    const session = await engine.start("pt-bay-4");
    expect(session.id).toBeDefined();
    expect(session.getElapsedSeconds()).toBeGreaterThanOrEqual(0);

    const firstCard = session.getLatestCard();
    expect(firstCard).toBeDefined();
    expect(firstCard?.status).toBe("Suggested — clinician confirms");

    // Clinician acknowledges action
    const ackRes = await engine.ack(session.id, "Shock 200 J biphasic (or manufacturer dose)", "Dr. Grey");
    expect(ackRes.acknowledged).toBe(true);
    expect(ackRes.auditId).toBeDefined();

    // Verify audit recorded clinician acknowledgement as executed
    const auditLogs = await deps.audit.list();
    const ackAudit = auditLogs.find((l) => (l.event as any).type === "codeblue.ack");
    expect(ackAudit).toBeDefined();
    expect(ackAudit.outcome).toBe("executed");
    expect((ackAudit.event as any).clinician).toBe("Dr. Grey");

    // Stopping session
    const stopRes = await engine.stop(session.id, "Dr. Grey");
    expect(stopRes.stopped).toBe(true);
    expect(session.isStopped()).toBe(true);
  });

  it("simulator generates continuous 250 Hz waveforms across clinical phases", () => {
    const sim = new CodeBlueSimulator();

    // Initial VF phase
    sim.setElapsedSeconds(10);
    const vfState = sim.getCurrentState();
    expect(vfState.currentPhase).toBe("VF_INITIAL");
    expect(vfState.isShockable).toBe(true);
    expect(vfState.hasPulse).toBe(false);
    expect(vfState.waveformChunk.length).toBe(250);

    // ROSC phase
    sim.setElapsedSeconds(110);
    const roscState = sim.getCurrentState();
    expect(roscState.currentPhase).toBe("ROSC");
    expect(roscState.hasPulse).toBe(true);
    expect(roscState.heartRateBpm).toBe(82);
    expect(roscState.isShockable).toBe(false);
  });
});

describe("6. HTTP API Routes (/codeblue)", () => {
  function createMockHttp(method: string, url: string, headers: Record<string, string>, bodyObj?: any) {
    const req: any = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() {
        if (bodyObj !== undefined) {
          yield Buffer.from(JSON.stringify(bodyObj));
        }
      },
    };

    let statusCode = 0;
    let responseHeaders: Record<string, string> = {};
    let responseText = "";

    const res: any = {
      writeHead(status: number, h: Record<string, string>) {
        statusCode = status;
        responseHeaders = h;
      },
      end(chunk?: string) {
        if (chunk) responseText += chunk;
      },
    };

    return {
      req: req as http.IncomingMessage,
      res: res as http.ServerResponse,
      get: () => {
        let json = null;
        try {
          json = responseText ? JSON.parse(responseText) : null;
        } catch {
          // not json
        }
        return {
          status: statusCode,
          headers: responseHeaders,
          json,
          text: responseText,
        };
      },
    };
  }

  it("serves static trauma-bay HTML on GET /codeblue", async () => {
    const deps = setupDeps();
    const engine = new CodeBlueEngine(deps);
    const { req, res, get } = createMockHttp("GET", "/codeblue", {});

    const handled = await handleCodeBlueRoute(req, res, engine, "secret-key", (a, b) => a === b);
    expect(handled).toBe(true);
    const result = get();
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.text).toContain("MEDICLUSTER — CODE BLUE WAR ROOM");
    expect(result.text).toContain("ecgCanvas");
  });

  it("rejects unauthorized start request without admin key", async () => {
    const deps = setupDeps();
    const engine = new CodeBlueEngine(deps);
    const { req, res, get } = createMockHttp("POST", "/codeblue/start", {}, { patientId: "p1" });

    const handled = await handleCodeBlueRoute(req, res, engine, "secret-key", (a, b) => a === b);
    expect(handled).toBe(true);
    expect(get().status).toBe(401);
  });

  it("starts session, retrieves card, acknowledges action, and stops session via API", async () => {
    const deps = setupDeps();
    const engine = new CodeBlueEngine(deps);
    const adminKey = "secret-key";
    const authHeaders = { "x-admin-key": adminKey, "content-type": "application/json" };

    // 1. POST /codeblue/start
    const startHttp = createMockHttp("POST", "/codeblue/start", authHeaders, { patientId: "pt-api-10" });
    await handleCodeBlueRoute(startHttp.req, startHttp.res, engine, adminKey, (a, b) => a === b);
    const startRes = startHttp.get();
    expect(startRes.status).toBe(200);
    const sessionId = startRes.json.session.id;
    expect(sessionId).toBeDefined();

    // 2. GET /codeblue/:id/card
    const cardHttp = createMockHttp("GET", `/codeblue/${sessionId}/card`, authHeaders);
    await handleCodeBlueRoute(cardHttp.req, cardHttp.res, engine, adminKey, (a, b) => a === b);
    const cardRes = cardHttp.get();
    expect(cardRes.status).toBe(200);
    expect(cardRes.json.card.status).toBe("Suggested — clinician confirms");

    // 3. POST /codeblue/:id/ack
    const ackHttp = createMockHttp("POST", `/codeblue/${sessionId}/ack`, authHeaders, { action: "Shock 200 J biphasic" });
    await handleCodeBlueRoute(ackHttp.req, ackHttp.res, engine, adminKey, (a, b) => a === b);
    const ackRes = ackHttp.get();
    expect(ackRes.status).toBe(200);
    expect(ackRes.json.acknowledged).toBe(true);

    // 4. POST /codeblue/:id/stop
    const stopHttp = createMockHttp("POST", `/codeblue/${sessionId}/stop`, authHeaders);
    await handleCodeBlueRoute(stopHttp.req, stopHttp.res, engine, adminKey, (a, b) => a === b);
    const stopRes = stopHttp.get();
    expect(stopRes.status).toBe(200);
    expect(stopRes.json.stopped).toBe(true);
  });
});
