import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface DrugInteraction {
  interacting_classes: string[];
  drugs: string[];
  severity: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  effect: string;
}

export interface DrugRule {
  name: string;
  allergies: string[];
  contraindications: string[];
  alternative?: string;
  interactions: DrugInteraction[];
}

export interface DrugDatabase {
  drugs: Record<string, DrugRule>;
}

export interface InteractionCheckResult {
  allowed: boolean;
  veto: boolean;
  vetoReason?: string;
  recommendedAlternative?: string;
  warnings: string[];
  matchedInteractions: {
    drug: string;
    interactingWith: string;
    severity: string;
    effect: string;
  }[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedDb: DrugDatabase | null = null;

export function getDrugDatabase(): DrugDatabase {
  if (!cachedDb) {
    const raw = readFileSync(join(__dirname, "interactions.json"), "utf8");
    cachedDb = JSON.parse(raw) as DrugDatabase;
  }
  return cachedDb;
}

export function checkDrugSafety(
  candidateDrug: string,
  patientMedications: string[] = [],
  patientAllergies: string[] = [],
): InteractionCheckResult {
  const db = getDrugDatabase();
  const drugKey = candidateDrug.toLowerCase().trim();
  const rule = db.drugs[drugKey];

  const warnings: string[] = [];
  const matchedInteractions: InteractionCheckResult["matchedInteractions"] = [];

  if (!rule) {
    return {
      allowed: true,
      veto: false,
      warnings: [],
      matchedInteractions: [],
    };
  }

  // Check allergy match
  const normalizedAllergies = patientAllergies.map((a) => a.toLowerCase().trim());
  const allergyHit = rule.allergies.find((allergen) =>
    normalizedAllergies.some((a) => a.includes(allergen) || allergen.includes(a)),
  );

  if (allergyHit) {
    const vetoReason = `Documented patient allergy to ${allergyHit}. Contraindicates ${rule.name}.`;
    return {
      allowed: false,
      veto: true,
      vetoReason,
      recommendedAlternative: rule.alternative,
      warnings: [vetoReason, rule.alternative ? `Recommended alternative: ${rule.alternative}` : ""].filter(Boolean),
      matchedInteractions: [],
    };
  }

  // Check drug-drug interactions
  const normalizedMeds = patientMedications.map((m) => m.toLowerCase().trim());
  for (const interaction of rule.interactions) {
    for (const interactingDrug of interaction.drugs) {
      const match = normalizedMeds.find(
        (m) => m.includes(interactingDrug) || interactingDrug.includes(m),
      );
      if (match) {
        matchedInteractions.push({
          drug: rule.name,
          interactingWith: match,
          severity: interaction.severity,
          effect: interaction.effect,
        });
        warnings.push(
          `[${interaction.severity}] ${rule.name} + ${match}: ${interaction.effect}`,
        );
      }
    }
  }

  return {
    allowed: true,
    veto: false,
    warnings,
    matchedInteractions,
    recommendedAlternative: rule.alternative,
  };
}
