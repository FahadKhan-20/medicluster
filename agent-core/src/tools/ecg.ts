/**
 * agent-core/src/tools/ecg.ts
 * Tool for 12-lead ECG analysis via the intelligence engine proxy.
 */

import type { BackendClient, BackendResult } from "./backend.js";
import type { Tool, ToolGroup, ToolResult } from "./registry.js";

export interface EcgProbabilities {
  NORM: number;
  MI: number;
  STTC: number;
  CD: number;
  HYP: number;
}

export interface EcgAnalysisResult {
  probabilities: EcgProbabilities;
  top: keyof EcgProbabilities | string;
  model: string;
  warning?: string;
}

export function validateEcgArgs(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return ["args must be an object"];
  }
  const a = args as Record<string, unknown>;
  const errors: string[] = [];

  if (!Array.isArray(a.signal)) {
    errors.push("signal must be an array of 12 leads");
  } else if (a.signal.length !== 12) {
    errors.push(`signal must have exactly 12 leads, got ${a.signal.length}`);
  } else {
    for (let i = 0; i < 12; i++) {
      if (!Array.isArray(a.signal[i]) || a.signal[i].length !== 1000) {
        errors.push(`lead ${i} must have exactly 1000 samples`);
        break;
      }
    }
  }

  if (a.lead_order !== undefined) {
    if (!Array.isArray(a.lead_order) || a.lead_order.length !== 12) {
      errors.push("lead_order must be an array of 12 strings if provided");
    }
  }

  return errors;
}

export const ecgAnalyzeTool: Tool = {
  name: "ecg.analyze",
  group: "ecg" as ToolGroup,
  action: "analyze",
  schema: {
    type: "object",
    properties: {
      signal: { type: "object" },
    },
    required: ["signal"],
    additionalProperties: false,
  },
  async run(args: Record<string, unknown>, client: BackendClient): Promise<ToolResult> {
    const errors = validateEcgArgs(args);
    if (errors.length) {
      return { ok: false, status: 0, error: `invalid arguments: ${errors.join("; ")}`, retryable: false };
    }
    return client.call("POST", "/api/intelligence/ecg/analyze", {
      signal: args.signal,
      lead_order: args.lead_order,
    });
  },
};
