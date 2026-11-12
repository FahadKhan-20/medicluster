/**
 * Consensus Engine for Code Blue Resuscitation War Room:
 * Uses Jev (Decider) to select the optimal consensus action from candidate recommendations
 * proposed by Intensivist, Pharmacologist, and Cardiologist specialists.
 *
 * Safety Invariants:
 * - NEVER executes actions: every card carries status "Suggested — clinician confirms".
 * - Validated against Gate (rate limits, kill switch, safety policy).
 * - Every Consensus Card is logged through the immutable Audit ledger.
 */

import { choice, noul, type Decider } from "../judge/jev.js";
import type { Gate } from "../control/gate.js";
import type { Audit } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { SpecialistRecommendation } from "./specialists.js";
import { buildRationaleWithGemini } from "./specialists.js";
import type { LlmProvider } from "../llm/provider.js";

export interface ConsensusCard {
  id: string;
  sessionId: string;
  action: string;
  confidence: number;
  supporting_agents: string[];
  conflicts: string[];
  warnings: string[];
  next_due_in_s?: number;
  status: "Suggested — clinician confirms";
  rationale: string;
  timestamp: string;
  auditId: string;
}

export interface ConsensusInput {
  sessionId: string;
  patientId: string;
  intensivist: SpecialistRecommendation;
  pharmacologist: SpecialistRecommendation;
  cardiologist: SpecialistRecommendation;
  nextDueInSeconds?: number;
  jev: Decider;
  gate: Gate;
  audit: Audit;
  state: AgentState;
  llm?: LlmProvider;
}

export class ConsensusEngine {
  async resolve(input: ConsensusInput): Promise<ConsensusCard> {
    const {
      sessionId,
      patientId,
      intensivist,
      pharmacologist,
      cardiologist,
      nextDueInSeconds,
      jev,
      gate,
      audit,
      state,
      llm,
    } = input;

    const timestamp = new Date().toISOString();
    const cardId = `card_${sessionId}_${Date.now()}`;

    // 1. Audit Start
    const auditId = await audit.start({
      type: "codeblue.consensus",
      sessionId,
      patientId,
      cardId,
      timestamp,
      specialists: {
        intensivist: intensivist.action,
        pharmacologist: pharmacologist.action,
        cardiologist: cardiologist.action,
      },
    });

    // 2. Identify candidate actions
    // If pharmacologist issued a hard veto, the veto alternative overrides/modifies the candidate pool
    const candidatesMap: Record<string, string> = {};
    const rawCandidates: { key: string; action: string; agent: string }[] = [];

    if (pharmacologist.veto) {
      candidatesMap["veto_action"] = pharmacologist.action;
      rawCandidates.push({ key: "veto_action", action: pharmacologist.action, agent: "Pharmacologist" });
    } else {
      candidatesMap["intensivist_action"] = intensivist.action;
      rawCandidates.push({ key: "intensivist_action", action: intensivist.action, agent: "Intensivist" });

      if (pharmacologist.action !== intensivist.action) {
        candidatesMap["pharm_action"] = pharmacologist.action;
        rawCandidates.push({ key: "pharm_action", action: pharmacologist.action, agent: "Pharmacologist" });
      }
    }

    if (!candidatesMap["cardio_action"] && cardiologist.action !== intensivist.action) {
      candidatesMap["cardio_action"] = cardiologist.action;
      rawCandidates.push({ key: "cardio_action", action: cardiologist.action, agent: "Cardiologist" });
    }

    // Always have at least 1 candidate
    if (Object.keys(candidatesMap).length === 0) {
      candidatesMap["default_action"] = intensivist.action;
      rawCandidates.push({ key: "default_action", action: intensivist.action, agent: "Intensivist" });
    }

    // 3. Jev Decision
    const jevQuestions = {
      action: choice(
        "Which resuscitation action should the clinical team take next?",
        candidatesMap,
      ),
      act_now: noul(
        "Acting now on this consensus action is safe and adheres to ACLS protocol",
      ),
    };

    const jevState = {
      patientId,
      sessionId,
      intensivist: { action: intensivist.action, rationale: intensivist.rationale, confidence: intensivist.confidence },
      pharmacologist: { action: pharmacologist.action, veto: pharmacologist.veto, warnings: pharmacologist.warnings },
      cardiologist: { action: cardiologist.action, confidence: cardiologist.confidence },
    };

    const decision = await jev.decide(jevState, jevQuestions, "codeblue");
    await audit.append(auditId, {
      kind: "jev",
      data: {
        answers: decision.answers,
        fallback: decision.fallback,
        cost: decision.cost,
        error: decision.error,
      },
    });

    const chosenKey = decision.answers.action?.choice ?? Object.keys(candidatesMap)[0];
    const chosenAction = candidatesMap[chosenKey] ?? intensivist.action;
    const actionProb = decision.answers.action?.probabilities?.[chosenKey] ?? 0.85;
    const actNow = decision.answers.act_now?.noul ?? 0.90;

    // 4. Determine Supporting Agents and Conflicts
    const supporting_agents: string[] = [];
    const conflicts: string[] = [];

    // Intensivist
    if (chosenAction.toLowerCase().includes(intensivist.action.toLowerCase()) || intensivist.action.toLowerCase().includes(chosenAction.toLowerCase())) {
      supporting_agents.push("Intensivist");
    } else {
      conflicts.push(`Intensivist recommended: ${intensivist.action}`);
    }

    // Pharmacologist
    if (pharmacologist.veto) {
      if (chosenAction === pharmacologist.action) {
        supporting_agents.push("Pharmacologist (Vetoed Original)");
      } else {
        conflicts.push(`Pharmacologist VETO: ${pharmacologist.rationale}`);
      }
    } else if (pharmacologist.action === chosenAction || !pharmacologist.warnings.length) {
      supporting_agents.push("Pharmacologist");
    } else {
      conflicts.push(`Pharmacologist note: ${pharmacologist.action}`);
    }

    // Cardiologist
    if (chosenAction.toLowerCase().includes("defibrillate") || chosenAction.toLowerCase().includes("shock")) {
      if (cardiologist.action.toLowerCase().includes("shock") || cardiologist.action.toLowerCase().includes("defibrillate")) {
        supporting_agents.push("Cardiologist");
      }
    } else if (cardiologist.action === chosenAction) {
      supporting_agents.push("Cardiologist");
    }

    // Deduplicate
    const finalSupporting = [...new Set(supporting_agents)];
    if (finalSupporting.length === 0) finalSupporting.push("ACLS Protocol");

    // Aggregate Warnings
    const warnings = [
      ...intensivist.warnings,
      ...pharmacologist.warnings,
      ...cardiologist.warnings,
    ];
    if (pharmacologist.veto && pharmacologist.rationale) {
      warnings.unshift(`[PHARMACOLOGIST VETO] ${pharmacologist.rationale}`);
    }

    // 5. Gate & Kill-Switch Recheck
    const key = `codeblue:${sessionId}:${Date.now()}`;
    const stopped = await state.isStopped();
    const done = await state.isDone(key);

    const gateVerdict = gate.check({
      group: "clinical",
      action: chosenAction,
      actionProb,
      actNow,
      fallback: decision.fallback || !!decision.error,
      stopped,
      key,
      done,
    });

    await audit.append(auditId, {
      kind: "gate",
      data: { key, ...gateVerdict, stopped },
    });

    // 6. Gemini One-Line Plain-Language Rationale
    const rationale = await buildRationaleWithGemini(
      llm,
      chosenAction,
      intensivist,
      pharmacologist,
      cardiologist,
    );

    // 7. Complete Audit Entry (Always review: clinician confirms before execution)
    await audit.finish(auditId, "review", "suggested_clinician_confirms");

    // 8. Return Consensus Action Card
    const card: ConsensusCard = {
      id: cardId,
      sessionId,
      action: chosenAction,
      confidence: Math.round(actionProb * actNow * 100) / 100,
      supporting_agents: finalSupporting,
      conflicts,
      warnings,
      next_due_in_s: nextDueInSeconds,
      status: "Suggested — clinician confirms",
      rationale,
      timestamp,
      auditId,
    };

    return card;
  }
}
