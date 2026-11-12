/**
 * Specialist Agents for Code Blue Resuscitation War Room:
 * 1. Intensivist: ACLS rule engine (cycle timing, shock delivery, drug sequencing)
 * 2. Pharmacologist: Patient-specific renal function (eGFR via CKD-EPI 2021), allergy match, drug interactions & veto
 * 3. Cardiologist: Rhythm classifier & 12-lead ECG analysis
 *
 * Gemini (existing LlmProvider) only produces a one-line plain-language rationale.
 */

import {
  CPR_CYCLE_SECONDS,
  SHOCK_DOSE_BIPHASIC,
  EPINEPHRINE_DOSE,
  EPINEPHRINE_INTERVAL_MIN_SECONDS,
  AMIODARONE_FIRST_DOSE,
  AMIODARONE_SECOND_DOSE,
  LIDOCAINE_FIRST_DOSE,
  isShockable,
} from "./acls.js";
import { calculateEgfr, type BiologicalSex, type EgfrResult } from "./egfr.js";
import { checkDrugSafety, type InteractionCheckResult } from "./interactions.js";
import type { RhythmClassifyResult } from "./clients.js";
import type { LlmProvider } from "../llm/provider.js";

export interface PatientRecord {
  patientId: string;
  name?: string;
  ageYears?: number;
  sex?: BiologicalSex;
  creatinineMgDl?: number;
  allergies?: string[];
  currentMedications?: string[];
}

export interface IntensivistState {
  codeTimeSeconds: number;
  cprElapsedSeconds: number;
  cprCycle: number;
  shockCount: number;
  lastShockTimeSeconds?: number;
  lastEpiTimeSeconds?: number;
  amiodaroneDosesGiven: number;
  currentRhythm: string;
  hasPulse: boolean;
  shockPending: boolean;
}

export interface SpecialistRecommendation {
  agent: "Intensivist" | "Pharmacologist" | "Cardiologist";
  action: string;
  rationale: string;
  confidence: number;
  warnings: string[];
  veto?: boolean;
  metadata?: Record<string, unknown>;
}

export class IntensivistAgent {
  evaluate(state: IntensivistState): SpecialistRecommendation {
    const {
      codeTimeSeconds,
      cprElapsedSeconds,
      shockCount,
      lastEpiTimeSeconds,
      amiodaroneDosesGiven,
      currentRhythm,
      hasPulse,
      shockPending,
    } = state;

    // 1. Check for ROSC
    if (hasPulse || currentRhythm === "ROSC") {
      return {
        agent: "Intensivist",
        action: "Initiate Post-Cardiac Arrest Care",
        rationale: "ROSC achieved. Maintain SpO2 92–98%, PaCO2 35–45 mmHg, target MAP ≥ 65 mmHg, obtain 12-lead ECG.",
        confidence: 0.99,
        warnings: [],
        metadata: { phase: "post_arrest" },
      };
    }

    const shockable = isShockable(currentRhythm);

    // 2. Rhythm check at 2-minute cycle completion
    if (cprElapsedSeconds >= CPR_CYCLE_SECONDS) {
      return {
        agent: "Intensivist",
        action: "Pause CPR for Rhythm and Pulse Check",
        rationale: `2-minute CPR cycle complete (${cprElapsedSeconds}s). Quick rhythm check (<10 seconds).`,
        confidence: 0.95,
        warnings: ["Minimize interruptions in chest compressions (< 10 seconds)."],
        metadata: { cprElapsedSeconds },
      };
    }

    // 3. Shockable branch (VF / Pulseless VT)
    if (shockable) {
      if (shockPending || shockCount === 0 || cprElapsedSeconds < 15) {
        return {
          agent: "Intensivist",
          action: SHOCK_DOSE_BIPHASIC,
          rationale: `Shockable rhythm confirmed (${currentRhythm}). Immediate defibrillation indicated.`,
          confidence: 0.98,
          warnings: ["Ensure clear before discharging defibrillator."],
          metadata: { shockCount: shockCount + 1 },
        };
      }

      // After 2nd shock: Epinephrine every 3-5 min
      const epiDue =
        shockCount >= 2 &&
        (lastEpiTimeSeconds === undefined ||
          codeTimeSeconds - lastEpiTimeSeconds >= EPINEPHRINE_INTERVAL_MIN_SECONDS);

      if (epiDue) {
        return {
          agent: "Intensivist",
          action: `Administer ${EPINEPHRINE_DOSE}`,
          rationale: `ACLS shockable pathway: Epinephrine indicated after 2nd shock, every 3–5 min.`,
          confidence: 0.94,
          warnings: [],
          metadata: { drug: "epinephrine" },
        };
      }

      // After 3rd shock: Amiodarone 300 mg
      if (shockCount >= 3 && amiodaroneDosesGiven === 0) {
        return {
          agent: "Intensivist",
          action: `Administer ${AMIODARONE_FIRST_DOSE}`,
          rationale: `Refractory VF/pVT after 3 shocks: First dose Amiodarone 300 mg IV/IO bolus indicated.`,
          confidence: 0.93,
          warnings: [],
          metadata: { drug: "amiodarone", doseMg: 300 },
        };
      }

      // After subsequent shock: Amiodarone 150 mg
      if (shockCount >= 5 && amiodaroneDosesGiven === 1) {
        return {
          agent: "Intensivist",
          action: `Administer ${AMIODARONE_SECOND_DOSE}`,
          rationale: `Refractory VF/pVT persistence: Second dose Amiodarone 150 mg IV/IO bolus indicated.`,
          confidence: 0.91,
          warnings: [],
          metadata: { drug: "amiodarone", doseMg: 150 },
        };
      }

      return {
        agent: "Intensivist",
        action: "Continue High-Quality CPR (2 min cycle)",
        rationale: `Deliver 100–120 compressions/min, 2–2.4 in depth. CPR countdown: ${Math.max(0, CPR_CYCLE_SECONDS - cprElapsedSeconds)}s remaining.`,
        confidence: 0.90,
        warnings: [],
        metadata: { remainingSeconds: CPR_CYCLE_SECONDS - cprElapsedSeconds },
      };
    }

    // 4. Non-shockable branch (Asystole / PEA)
    const epiDueNonShockable =
      lastEpiTimeSeconds === undefined ||
      codeTimeSeconds - lastEpiTimeSeconds >= EPINEPHRINE_INTERVAL_MIN_SECONDS;

    if (epiDueNonShockable) {
      return {
        agent: "Intensivist",
        action: `Administer ${EPINEPHRINE_DOSE} ASAP`,
        rationale: "Non-shockable arrest (Asystole/PEA): Give Epinephrine 1 mg IV/IO as soon as feasible, repeat every 3–5 min.",
        confidence: 0.96,
        warnings: ["Do not shock asystole or PEA."],
        metadata: { drug: "epinephrine" },
      };
    }

    return {
      agent: "Intensivist",
      action: "Continue High-Quality CPR & Treat Reversible Causes",
      rationale: `Consider 5 H's (Hypovolemia, Hypoxia, Hydrogen ion, Hypo/Hyperkalemia, Hypothermia) and 5 T's (Tension pneumothorax, Tamponade, Toxins, Thrombosis).`,
      confidence: 0.88,
      warnings: [],
      metadata: { remainingSeconds: CPR_CYCLE_SECONDS - cprElapsedSeconds },
    };
  }
}

export class PharmacologistAgent {
  evaluate(
    patient: PatientRecord | null | undefined,
    intensivistAction: string,
  ): SpecialistRecommendation {
    const warnings: string[] = [];
    let egfrInfo: EgfrResult | null = null;

    if (patient?.creatinineMgDl && patient?.ageYears && patient?.sex) {
      try {
        egfrInfo = calculateEgfr(patient.creatinineMgDl, patient.ageYears, patient.sex);
        if (egfrInfo.severeImpairment) {
          warnings.push(
            `Severe renal impairment: eGFR ${egfrInfo.egfr} mL/min/1.73m² (${egfrInfo.stage}). Anticipate altered clearance of post-arrest meds.`,
          );
        }
      } catch {
        // Soft-fail on invalid numeric input
      }
    }

    // Determine target drug in candidate action
    const actionLower = intensivistAction.toLowerCase();
    let targetDrug: string | null = null;
    if (actionLower.includes("amiodarone")) targetDrug = "amiodarone";
    else if (actionLower.includes("epinephrine")) targetDrug = "epinephrine";
    else if (actionLower.includes("lidocaine")) targetDrug = "lidocaine";

    if (!targetDrug) {
      return {
        agent: "Pharmacologist",
        action: intensivistAction,
        rationale: egfrInfo
          ? `Patient eGFR: ${egfrInfo.egfr} mL/min (${egfrInfo.stage}). No immediate drug interactions identified.`
          : "No immediate pharmaceutical contraindications or interactions identified.",
        confidence: 0.95,
        warnings,
        veto: false,
        metadata: { egfr: egfrInfo?.egfr },
      };
    }

    const check = checkDrugSafety(
      targetDrug,
      patient?.currentMedications ?? [],
      patient?.allergies ?? [],
    );

    warnings.push(...check.warnings);

    // Pharmacologist Veto on documented allergy
    if (check.veto) {
      const alternative = check.recommendedAlternative ?? LIDOCAINE_FIRST_DOSE;
      return {
        agent: "Pharmacologist",
        action: `Veto: Substitute with ${alternative}`,
        rationale: check.vetoReason || "Documented patient allergy contraindicates proposed medication.",
        confidence: 0.98,
        warnings,
        veto: true,
        metadata: { vetoReason: check.vetoReason, originalAction: intensivistAction, alternative },
      };
    }

    // Warnings present but drug allowed (e.g. Epinephrine with beta-blockers)
    if (check.warnings.length > 0) {
      return {
        agent: "Pharmacologist",
        action: intensivistAction,
        rationale: `Approved with precautions: ${check.warnings[0]}`,
        confidence: 0.88,
        warnings,
        veto: false,
        metadata: { egfr: egfrInfo?.egfr, interactions: check.matchedInteractions },
      };
    }

    return {
      agent: "Pharmacologist",
      action: intensivistAction,
      rationale: `${targetDrug.toUpperCase()} verified: No allergy conflicts or major contraindicated interactions.`,
      confidence: 0.96,
      warnings,
      veto: false,
      metadata: { egfr: egfrInfo?.egfr },
    };
  }
}

export class CardiologistAgent {
  evaluate(rhythm: RhythmClassifyResult | null | undefined): SpecialistRecommendation {
    if (!rhythm || !rhythm.probabilities) {
      return {
        agent: "Cardiologist",
        action: "Monitor Continuous ECG Rhythm Strip",
        rationale: "Acquiring telemetry signal for automated arrest-rhythm classification.",
        confidence: 0.60,
        warnings: ["Telemetry rhythm input pending."],
      };
    }

    const top = rhythm.top;
    const topProb = rhythm.probabilities[top] ?? 0.5;
    const isShock = isShockable(top);

    if (isShock) {
      return {
        agent: "Cardiologist",
        action: `Defibrillate Shockable Rhythm (${top})`,
        rationale: `Arrest rhythm classified as ${top} with ${(topProb * 100).toFixed(1)}% confidence by ${rhythm.model}. Shockable tachyarrhythmia.`,
        confidence: Math.min(0.99, Math.max(0.70, topProb)),
        warnings: [],
        metadata: { rhythm: top, probabilities: rhythm.probabilities },
      };
    }

    if (top === "ASYSTOLE") {
      return {
        agent: "Cardiologist",
        action: "Confirm Asystole & Resume Compressions",
        rationale: `Arrest rhythm classified as Asystole with ${(topProb * 100).toFixed(1)}% confidence. Non-shockable flatline. Verify leads & power.`,
        confidence: Math.min(0.99, Math.max(0.70, topProb)),
        warnings: ["Confirm true asystole in 2 orthogonal leads to rule out fine VF."],
        metadata: { rhythm: top, probabilities: rhythm.probabilities },
      };
    }

    // ORGANIZED / NSR
    return {
      agent: "Cardiologist",
      action: "Evaluate Rhythm and Palpate Central Pulse",
      rationale: `Organized rhythm detected (${(topProb * 100).toFixed(1)}% confidence). Check carotid pulse to distinguish ROSC from PEA.`,
      confidence: Math.min(0.98, Math.max(0.70, topProb)),
      warnings: ["Do not deliver shock to organized rhythm."],
      metadata: { rhythm: top, probabilities: rhythm.probabilities },
    };
  }
}

export const RATIONALE_PROMPT = [
  "You write a single-sentence clinical consensus rationale for a Code Blue resuscitation action card.",
  "Return JSON only: {\"rationale\": \"<one concise clinical sentence summarizing the next critical step>\"}.",
  "Facts only: strictly follow ACLS guidelines and the provided specialist recommendations.",
  "Never invent medications, doses, or patient history not in the state.",
].join("\n");

export async function buildRationaleWithGemini(
  llm: LlmProvider | null | undefined,
  action: string,
  intensivist: SpecialistRecommendation,
  pharmacologist: SpecialistRecommendation,
  cardiologist: SpecialistRecommendation,
): Promise<string> {
  const fallback = `${action}. Intensivist: ${intensivist.action}. Cardiologist: ${cardiologist.action}.`;
  if (!llm) return fallback;

  try {
    const userPayload = JSON.stringify({
      targetAction: action,
      intensivist: { action: intensivist.action, rationale: intensivist.rationale },
      pharmacologist: { action: pharmacologist.action, warnings: pharmacologist.warnings },
      cardiologist: { action: cardiologist.action, rationale: cardiologist.rationale },
    });
    const res = await llm.json<{ rationale?: string }>(RATIONALE_PROMPT, userPayload);
    if (typeof res?.rationale === "string" && res.rationale.trim().length > 0) {
      return res.rationale.trim().slice(0, 250);
    }
  } catch {
    // Soft fallback on LLM failure per specification
  }
  return fallback;
}
