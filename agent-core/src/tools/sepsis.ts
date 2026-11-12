// Tool sepsis.score: calls Python ML engine to evaluate early sepsis risk from vitals sequence.
import type { BackendClient, BackendResult } from "./backend.js";
import type { Tool, ToolSchema } from "./registry.js";

export type SepsisHour = {
  HR?: number;
  O2Sat?: number;
  Temp?: number;
  SBP?: number;
  MAP?: number;
  DBP?: number;
  Resp?: number;
  WBC?: number;
  Lactate?: number;
  Creatinine?: number;
  Platelets?: number;
  Glucose?: number;
  Age?: number;
  [key: string]: unknown;
};

export type SepsisScoreResult = {
  risk: number;
  band: "low" | "medium" | "high";
  top_factors: string[];
  model: string;
};

export const SEPSIS_TOOL_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    hours: { type: "object", maxJsonLength: 8000 },
  },
  required: ["hours"],
  additionalProperties: false,
};

export const sepsisScoreTool: Tool = {
  name: "sepsis.score",
  group: "sepsis" as any,
  action: "score" as any,
  schema: SEPSIS_TOOL_SCHEMA,
  async run(args: Record<string, unknown>, client: BackendClient): Promise<BackendResult> {
    const hours = args.hours;
    if (!Array.isArray(hours) || hours.length === 0) {
      return {
        ok: false,
        status: 0,
        error: "invalid arguments: hours must be a non-empty array",
        retryable: false,
      };
    }
    return client.call("POST", "/api/ml/sepsis/score", { hours });
  },
};

/**
 * Fetch patient readings from backend allowlisted route.
 */
export async function fetchPatientReadings(
  client: Pick<BackendClient, "call">,
  patientId: string,
): Promise<BackendResult> {
  return client.call("GET", `/api/ml/readings/${encodeURIComponent(patientId)}`);
}

/**
 * Turn backend Reading docs or vitals readings into chronological hourly observations
 * for the last 12 hours leading up to `now`.
 */
export function formatReadingsToHourlySequence(
  readings: any[],
  now: Date = new Date(),
  windowHours = 12,
): SepsisHour[] {
  if (!Array.isArray(readings) || readings.length === 0) return [];

  const nowMs = now.getTime();
  const windowStartMs = nowMs - windowHours * 3600 * 1000;

  // Filter to window
  const windowReadings = readings
    .map((r) => {
      const takenAt = r.takenAt ? new Date(r.takenAt).getTime() : r.createdAt ? new Date(r.createdAt).getTime() : nowMs;
      return { ...r, _ts: takenAt };
    })
    .filter((r) => r._ts >= windowStartMs && r._ts <= nowMs)
    .sort((a, b) => a._ts - b._ts);

  if (windowReadings.length === 0) return [];

  // Group readings into hourly buckets
  const buckets = new Map<number, Record<string, number>>();

  for (const r of windowReadings) {
    const hourBucket = Math.floor((r._ts - windowStartMs) / (3600 * 1000));
    const curr = buckets.get(hourBucket) ?? {};

    // Support Reading schema (type: "bp" | "glucose" | "hr", value, diastolic)
    if (typeof r.type === "string") {
      const t = r.type.toLowerCase();
      const val = Number(r.value);
      if (Number.isFinite(val)) {
        if (t === "bp") {
          curr.SBP = val;
          if (r.diastolic != null && Number.isFinite(Number(r.diastolic))) {
            curr.DBP = Number(r.diastolic);
            curr.MAP = curr.DBP + (curr.SBP - curr.DBP) / 3.0;
          }
        } else if (t === "glucose") {
          curr.Glucose = val;
        } else if (t === "hr" || t === "heart_rate") {
          curr.HR = val;
        } else if (t === "spo2" || t === "o2sat") {
          curr.O2Sat = val;
        } else if (t === "resp" || t === "respiratory_rate") {
          curr.Resp = val;
        } else if (t === "temp" || t === "temperature") {
          curr.Temp = val;
        }
      }
    }

    // Also support comprehensive vitals objects with direct field names
    const directFields: [string, string][] = [
      ["HR", "heart_rate"],
      ["HR", "hr"],
      ["O2Sat", "spo2"],
      ["O2Sat", "o2sat"],
      ["Temp", "temperature"],
      ["Temp", "temp"],
      ["SBP", "systolic_bp"],
      ["SBP", "sbp"],
      ["DBP", "diastolic_bp"],
      ["DBP", "dbp"],
      ["MAP", "map"],
      ["Resp", "respiratory_rate"],
      ["Resp", "resp"],
      ["WBC", "wbc"],
      ["Lactate", "lactate"],
      ["Creatinine", "creatinine"],
      ["Platelets", "platelets"],
      ["Glucose", "glucose"],
      ["Age", "age"],
    ];

    for (const [targetKey, sourceKey] of directFields) {
      const v = r[sourceKey] ?? r[targetKey];
      if (v != null && Number.isFinite(Number(v))) {
        curr[targetKey] = Number(v);
      }
    }

    if (curr.SBP != null && curr.DBP != null && curr.MAP == null) {
      curr.MAP = curr.DBP + (curr.SBP - curr.DBP) / 3.0;
    }

    buckets.set(hourBucket, curr);
  }

  // Convert populated buckets in chronological order
  const sortedHourIndices = [...buckets.keys()].sort((a, b) => a - b);
  return sortedHourIndices.map((idx) => buckets.get(idx)!);
}
