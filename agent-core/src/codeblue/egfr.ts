/**
 * CKD-EPI 2021 Race-Free Equation for Estimated Glomerular Filtration Rate (eGFR).
 * Source: Inker LA, Eneanya ND, Coresh J, et al. "New Creatinine- and Cystatin C–Based
 * Equations to Estimate GFR without Race." N Engl J Med. 2021;385(19):1737-1749.
 *
 * Equation:
 * eGFR = 142 * min(Scr / kappa, 1)^alpha * max(Scr / kappa, 1)^(-1.200) * 0.9938^Age * (1.012 if female else 1.0)
 *
 * Parameters:
 * - Female: kappa = 0.7, alpha = -0.241, multiplier = 1.012
 * - Male:   kappa = 0.9, alpha = -0.302, multiplier = 1.000
 * - Scr: serum creatinine in mg/dL
 * - Age: years
 */

export type BiologicalSex = "M" | "F" | "male" | "female";

export interface EgfrResult {
  egfr: number;
  stage: string;
  description: string;
  renalImpaired: boolean;
  severeImpairment: boolean;
}

export function calculateEgfr(
  creatinineMgDl: number,
  ageYears: number,
  sex: BiologicalSex,
): EgfrResult {
  if (creatinineMgDl <= 0 || !Number.isFinite(creatinineMgDl)) {
    throw new Error(`Invalid serum creatinine: ${creatinineMgDl}`);
  }
  if (ageYears <= 0 || !Number.isFinite(ageYears)) {
    throw new Error(`Invalid age: ${ageYears}`);
  }

  const isFemale = sex === "F" || sex.toLowerCase() === "female";
  const kappa = isFemale ? 0.7 : 0.9;
  const alpha = isFemale ? -0.241 : -0.302;
  const sexFactor = isFemale ? 1.012 : 1.0;

  const ratio = creatinineMgDl / kappa;
  const minRatio = Math.min(ratio, 1.0);
  const maxRatio = Math.max(ratio, 1.0);

  const egfr = Math.round(
    142 *
      Math.pow(minRatio, alpha) *
      Math.pow(maxRatio, -1.2) *
      Math.pow(0.9938, ageYears) *
      sexFactor,
  );

  let stage = "G1";
  let description = "Normal or high kidney function";
  let renalImpaired = false;
  let severeImpairment = false;

  if (egfr >= 90) {
    stage = "G1";
    description = "Normal or high (≥90 mL/min/1.73m²)";
  } else if (egfr >= 60) {
    stage = "G2";
    description = "Mildly decreased (60–89 mL/min/1.73m²)";
  } else if (egfr >= 45) {
    stage = "G3a";
    description = "Mild to moderately decreased (45–59 mL/min/1.73m²)";
    renalImpaired = true;
  } else if (egfr >= 30) {
    stage = "G3b";
    description = "Moderately to severely decreased (30–44 mL/min/1.73m²)";
    renalImpaired = true;
  } else if (egfr >= 15) {
    stage = "G4";
    description = "Severely decreased (15–29 mL/min/1.73m²)";
    renalImpaired = true;
    severeImpairment = true;
  } else {
    stage = "G5";
    description = "Kidney failure (<15 mL/min/1.73m²)";
    renalImpaired = true;
    severeImpairment = true;
  }

  return { egfr, stage, description, renalImpaired, severeImpairment };
}
