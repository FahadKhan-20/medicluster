/**
 * Code Blue Session Engine:
 * Manages active resuscitation sessions, real-time code timers, 2-minute CPR cycles,
 * specialist agent evaluation ticks, consensus card generation, and clinician acknowledgements.
 */

import { CPR_CYCLE_SECONDS, EPINEPHRINE_INTERVAL_MIN_SECONDS } from "./acls.js";
import {
  IntensivistAgent,
  PharmacologistAgent,
  CardiologistAgent,
  type PatientRecord,
  type SpecialistRecommendation,
} from "./specialists.js";
import { ConsensusEngine, type ConsensusCard } from "./consensus.js";
import { CodeBlueSimulator, type MonitorState } from "./simulator.js";
import type { Decider } from "../judge/jev.js";
import type { Gate } from "../control/gate.js";
import type { Audit } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { LlmProvider } from "../llm/provider.js";
import type { RhythmClassifyResult } from "./clients.js";

export interface CodeBlueSessionDeps {
  jev: Decider;
  gate: Gate;
  audit: Audit;
  state: AgentState;
  llm?: LlmProvider;
}

export interface SessionTelemetry {
  sessionId: string;
  patientId: string;
  codeTimeSeconds: number;
  cprCycleNumber: number;
  cprRemainingSeconds: number;
  cprElapsedSeconds: number;
  nextEpiDueInSeconds: number;
  shockCount: number;
  amiodaroneDosesGiven: number;
  hasPulse: boolean;
  currentRhythm: string;
  heartRateBpm: number;
  monitorWaveform: number[];
  phaseDescription: string;
  specialists: {
    intensivist: SpecialistRecommendation;
    pharmacologist: SpecialistRecommendation;
    cardiologist: SpecialistRecommendation;
  };
  card: ConsensusCard | null;
  stopped: boolean;
}

export class CodeBlueSession {
  readonly id: string;
  readonly patientId: string;
  readonly patientRecord: PatientRecord;
  readonly startTimeMs: number;
  private stopped = false;

  private shockCount = 0;
  private lastShockTimeSeconds?: number;
  private lastEpiTimeSeconds?: number;
  private amiodaroneDosesGiven = 0;
  private hasPulse = false;
  private shockPending = false;

  private readonly simulator: CodeBlueSimulator;
  private readonly intensivist = new IntensivistAgent();
  private readonly pharmacologist = new PharmacologistAgent();
  private readonly cardiologist = new CardiologistAgent();
  private readonly consensus = new ConsensusEngine();

  private latestCard: ConsensusCard | null = null;
  private latestTelemetry: SessionTelemetry | null = null;

  constructor(
    id: string,
    patientId: string,
    patientRecord?: PatientRecord,
    useSimulator = true,
  ) {
    this.id = id;
    this.patientId = patientId;
    this.startTimeMs = Date.now();
    this.patientRecord = patientRecord ?? {
      patientId,
      name: "Trauma Patient Doe",
      ageYears: 64,
      sex: "M",
      creatinineMgDl: 1.6,
      allergies: ["iodine"], // Demo allergy for amiodarone veto
      currentMedications: ["carvedilol", "lisinopril"], // Demo beta-blocker interaction
    };
    this.simulator = new CodeBlueSimulator();
    if (!useSimulator) {
      // If not using simulator, manual ticks
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  getElapsedSeconds(): number {
    return Math.floor((Date.now() - this.startTimeMs) / 1000);
  }

  async tick(deps: CodeBlueSessionDeps): Promise<SessionTelemetry> {
    const elapsed = this.getElapsedSeconds();
    const monitor = this.simulator.getCurrentState();
    this.hasPulse = monitor.hasPulse;

    const cprElapsedSeconds = elapsed % CPR_CYCLE_SECONDS;
    const cprCycleNumber = Math.floor(elapsed / CPR_CYCLE_SECONDS) + 1;
    const cprRemainingSeconds = Math.max(0, CPR_CYCLE_SECONDS - cprElapsedSeconds);

    const nextEpiDueInSeconds =
      this.lastEpiTimeSeconds === undefined
        ? 0
        : Math.max(0, EPINEPHRINE_INTERVAL_MIN_SECONDS - (elapsed - this.lastEpiTimeSeconds));

    // 1. Evaluate Cardiologist
    const rhythmResult: RhythmClassifyResult = {
      probabilities: monitor.isShockable
        ? { VF: 0.88, VT: 0.08, ASYSTOLE: 0.02, ORGANIZED: 0.02 }
        : monitor.rhythmName === "ASYSTOLE"
          ? { ASYSTOLE: 0.95, VF: 0.02, VT: 0.01, ORGANIZED: 0.02 }
          : { ORGANIZED: 0.94, ASYSTOLE: 0.02, VF: 0.02, VT: 0.02 },
      top: monitor.rhythmName,
      model: "arrest-rhythm-v1",
    };
    const cardioRec = this.cardiologist.evaluate(rhythmResult);

    // 2. Evaluate Intensivist (ACLS Rule Engine)
    const intensivistRec = this.intensivist.evaluate({
      codeTimeSeconds: elapsed,
      cprElapsedSeconds,
      cprCycle: cprCycleNumber,
      shockCount: this.shockCount,
      lastShockTimeSeconds: this.lastShockTimeSeconds,
      lastEpiTimeSeconds: this.lastEpiTimeSeconds,
      amiodaroneDosesGiven: this.amiodaroneDosesGiven,
      currentRhythm: monitor.rhythmName,
      hasPulse: this.hasPulse,
      shockPending: this.shockPending,
    });

    // 3. Evaluate Pharmacologist (eGFR, allergy match, drug interactions & veto)
    const pharmRec = this.pharmacologist.evaluate(
      this.patientRecord,
      intensivistRec.action,
    );

    // 4. Consensus Decision with Jev + Gate + Audit
    const card = await this.consensus.resolve({
      sessionId: this.id,
      patientId: this.patientId,
      intensivist: intensivistRec,
      pharmacologist: pharmRec,
      cardiologist: cardioRec,
      nextDueInSeconds: Math.min(cprRemainingSeconds, nextEpiDueInSeconds || cprRemainingSeconds),
      jev: deps.jev,
      gate: deps.gate,
      audit: deps.audit,
      state: deps.state,
      llm: deps.llm,
    });

    this.latestCard = card;

    const telemetry: SessionTelemetry = {
      sessionId: this.id,
      patientId: this.patientId,
      codeTimeSeconds: elapsed,
      cprCycleNumber,
      cprRemainingSeconds,
      cprElapsedSeconds,
      nextEpiDueInSeconds,
      shockCount: this.shockCount,
      amiodaroneDosesGiven: this.amiodaroneDosesGiven,
      hasPulse: this.hasPulse,
      currentRhythm: monitor.rhythmName,
      heartRateBpm: monitor.heartRateBpm,
      monitorWaveform: monitor.waveformChunk,
      phaseDescription: monitor.phaseDescription,
      specialists: {
        intensivist: intensivistRec,
        pharmacologist: pharmRec,
        cardiologist: cardioRec,
      },
      card,
      stopped: this.stopped,
    };

    this.latestTelemetry = telemetry;
    return telemetry;
  }

  getLatestTelemetry(): SessionTelemetry | null {
    return this.latestTelemetry;
  }

  getLatestCard(): ConsensusCard | null {
    return this.latestCard;
  }

  async acknowledgeAction(
    action: string,
    clinician: string,
    deps: CodeBlueSessionDeps,
  ): Promise<{ acknowledged: boolean; auditId: string }> {
    const elapsed = this.getElapsedSeconds();
    const actionLower = action.toLowerCase();

    // Update internal clinical state based on confirmed action
    if (actionLower.includes("shock") || actionLower.includes("defibrillat")) {
      this.shockCount += 1;
      this.lastShockTimeSeconds = elapsed;
      this.shockPending = false;
    }
    if (actionLower.includes("epinephrine")) {
      this.lastEpiTimeSeconds = elapsed;
    }
    if (actionLower.includes("amiodarone")) {
      this.amiodaroneDosesGiven += 1;
    }
    if (actionLower.includes("lidocaine")) {
      this.amiodaroneDosesGiven += 1; // Counted against antiarrhythmic pathway
    }

    // Audit the human clinician confirmation
    const auditId = await deps.audit.start({
      type: "codeblue.ack",
      sessionId: this.id,
      patientId: this.patientId,
      action,
      clinician,
      codeTimeSeconds: elapsed,
      shockCount: this.shockCount,
      lastEpiTimeSeconds: this.lastEpiTimeSeconds,
      timestamp: new Date().toISOString(),
    });

    await deps.audit.finish(auditId, "executed", "clinician_confirmed");

    // Trigger an immediate tick to update recommendations
    await this.tick(deps);

    return { acknowledged: true, auditId };
  }
}

export class CodeBlueEngine {
  private sessions = new Map<string, CodeBlueSession>();

  constructor(private readonly deps: CodeBlueSessionDeps) {}

  async start(
    patientId: string,
    options?: { patientRecord?: PatientRecord; useSimulator?: boolean },
  ): Promise<CodeBlueSession> {
    const sessionId = `cb_${patientId.replace(/[^a-zA-Z0-9_-]/g, "")}_${Date.now()}`;
    const session = new CodeBlueSession(
      sessionId,
      patientId,
      options?.patientRecord,
      options?.useSimulator ?? true,
    );
    this.sessions.set(sessionId, session);

    // Initial audit log
    const auditId = await this.deps.audit.start({
      type: "codeblue.session_start",
      sessionId,
      patientId,
      patientRecord: session.patientRecord,
      timestamp: new Date().toISOString(),
    });
    await this.deps.audit.finish(auditId, "executed", "session_started");

    // Initial tick to populate first card
    await session.tick(this.deps);

    return session;
  }

  getSession(id: string): CodeBlueSession | undefined {
    return this.sessions.get(id);
  }

  async tick(id: string): Promise<SessionTelemetry> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Code Blue session ${id} not found`);
    return session.tick(this.deps);
  }

  async ack(
    id: string,
    action: string,
    clinician = "Dr. Code Blue Attending",
  ): Promise<{ acknowledged: boolean; auditId: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Code Blue session ${id} not found`);
    return session.acknowledgeAction(action, clinician, this.deps);
  }

  async stop(id: string, clinician = "Dr. Code Blue Attending"): Promise<{ stopped: boolean; auditId: string }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Code Blue session ${id} not found`);
    session.stop();

    const auditId = await this.deps.audit.start({
      type: "codeblue.session_stop",
      sessionId: id,
      patientId: session.patientId,
      codeTimeSeconds: session.getElapsedSeconds(),
      stoppedBy: clinician,
      timestamp: new Date().toISOString(),
    });
    await this.deps.audit.finish(auditId, "executed", "session_stopped");

    return { stopped: true, auditId };
  }
}
