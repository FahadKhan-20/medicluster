/**
 * AHA ACLS (American Heart Association Advanced Cardiovascular Life Support) Guidelines (2020/2023 Update).
 * Source:
 * - Merchant RM, et al. "Part 3: Adult Basic and Advanced Life Support: 2020 American Heart Association
 *   Guidelines for Cardiopulmonary Resuscitation and Emergency Cardiovascular Care." Circulation. 2020;142(suppl 2):S366–S468.
 * - Panchal AR, et al. "2023 American Heart Association Focused Update on Adult Advanced Cardiovascular Life Support."
 *   Circulation. 2023;148:e00–e00.
 *
 * All values and intervals below are strict constants derived directly from the ACLS Adult Cardiac Arrest Algorithm.
 */

/** Duration of one standard CPR cycle before rhythm/pulse check: 2 minutes (120 seconds). */
export const CPR_CYCLE_SECONDS = 120;

/** Prompts for rhythm check occur every 2 minutes at cycle completion. */
export const RHYTHM_CHECK_INTERVAL_SECONDS = 120;

/** Shock energy for initial and subsequent defibrillation shocks in VF/pVT. */
export const SHOCK_DOSE_BIPHASIC = "Shock 200 J biphasic (or manufacturer dose)";

/** Epinephrine dose and route for cardiac arrest. */
export const EPINEPHRINE_DOSE = "Epinephrine 1 mg IV/IO";

/** Minimum interval between epinephrine doses: 3 minutes (180 seconds). */
export const EPINEPHRINE_INTERVAL_MIN_SECONDS = 180;

/** Maximum interval between epinephrine doses: 5 minutes (300 seconds). */
export const EPINEPHRINE_INTERVAL_MAX_SECONDS = 300;

/** Standard dosing frequency target: every 4 minutes (240 seconds). */
export const EPINEPHRINE_INTERVAL_TARGET_SECONDS = 240;

/** Amiodarone first dose given after 3rd shock in refractory VF/pVT. */
export const AMIODARONE_FIRST_DOSE = "Amiodarone 300 mg IV/IO bolus";

/** Amiodarone second dose given after subsequent shock if VF/pVT persists. */
export const AMIODARONE_SECOND_DOSE = "Amiodarone 150 mg IV/IO bolus";

/** Lidocaine alternative first dose when amiodarone is contraindicated or unavailable. */
export const LIDOCAINE_FIRST_DOSE = "Lidocaine 1.0–1.5 mg/kg IV/IO";

/** Lidocaine alternative second dose. */
export const LIDOCAINE_SECOND_DOSE = "Lidocaine 0.5–0.75 mg/kg IV/IO";

/** Shockable arrest rhythms per ACLS protocol. */
export const SHOCKABLE_RHYTHMS = ["VF", "VT", "pVT"] as const;

/** Non-shockable arrest rhythms per ACLS protocol. */
export const NON_SHOCKABLE_RHYTHMS = ["ASYSTOLE", "PEA"] as const;

export type ShockableRhythm = (typeof SHOCKABLE_RHYTHMS)[number];
export type NonShockableRhythm = (typeof NON_SHOCKABLE_RHYTHMS)[number];
export type ArrestRhythm = ShockableRhythm | NonShockableRhythm | "ORGANIZED" | "ROSC";

export function isShockable(rhythm: string): boolean {
  const norm = rhythm.toUpperCase().trim();
  return norm === "VF" || norm === "VT" || norm === "PVT";
}

export function isArrestRhythm(rhythm: string): boolean {
  const norm = rhythm.toUpperCase().trim();
  return isShockable(norm) || norm === "ASYSTOLE" || norm === "PEA";
}

export interface EpiDueResult {
  dueInSeconds: number | null;
  statusText: string;
  isDueNow: boolean;
}

/**
 * ACLS Epinephrine timing calculation:
 * - Shockable (VF/pVT): First dose only after 2nd shock, then every 3–5 min.
 * - Non-shockable (Asystole/PEA): First dose ASAP, then every 3–5 min.
 * - ROSC / Pulse present: Not indicated (null).
 */
export function computeNextEpiDue(
  rhythm: string,
  hasPulse: boolean,
  shockCount: number,
  elapsedSeconds: number,
  lastEpiTimeSeconds?: number,
): EpiDueResult {
  const norm = rhythm.toUpperCase().trim();
  if (hasPulse || norm === "ROSC") {
    return { dueInSeconds: null, statusText: "N/A (ROSC)", isDueNow: false };
  }

  const shockable = isShockable(norm);
  if (shockable) {
    if (shockCount < 2) {
      return {
        dueInSeconds: null,
        statusText: "After Shock 2",
        isDueNow: false,
      };
    }
    // After 2nd shock in shockable rhythm:
    if (lastEpiTimeSeconds === undefined) {
      return {
        dueInSeconds: 0,
        statusText: "DUE NOW",
        isDueNow: true,
      };
    }
    const remaining = Math.max(0, EPINEPHRINE_INTERVAL_MIN_SECONDS - (elapsedSeconds - lastEpiTimeSeconds));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    return {
      dueInSeconds: remaining,
      statusText: remaining === 0 ? "DUE NOW" : timeStr,
      isDueNow: remaining === 0,
    };
  }

  // Non-shockable (Asystole / PEA):
  if (lastEpiTimeSeconds === undefined) {
    return {
      dueInSeconds: 0,
      statusText: "DUE NOW",
      isDueNow: true,
    };
  }
  const remaining = Math.max(0, EPINEPHRINE_INTERVAL_MIN_SECONDS - (elapsedSeconds - lastEpiTimeSeconds));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return {
    dueInSeconds: remaining,
    statusText: remaining === 0 ? "DUE NOW" : timeStr,
    isDueNow: remaining === 0,
  };
}
