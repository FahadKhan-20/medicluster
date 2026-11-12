import type { BackendClient, BackendResult } from "./backend.js";
import { type Tool, type ToolSchema, validateArgs } from "./registry.js";

export const RADAR_FORECAST_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["sessionId"],
  additionalProperties: false,
};

export const radarForecastTool: Tool = {
  name: "radar.forecast",
  group: "radar" as any,
  action: "forecast" as any,
  schema: RADAR_FORECAST_SCHEMA,
  async run(args: Record<string, unknown>, client: BackendClient): Promise<BackendResult> {
    const errors = validateArgs(radarForecastTool, args);
    if (errors.length) {
      return { ok: false, status: 0, error: `invalid arguments: ${errors.join("; ")}`, retryable: false };
    }
    const sessionId = encodeURIComponent(String(args.sessionId));
    const body: Record<string, unknown> = {};
    if (typeof args.steps === "number") body.steps = args.steps;
    if (typeof args.cursor === "number") body.cursor = args.cursor;
    return client.call(
      "POST",
      `/api/intelligence/radar/sessions/${sessionId}/forecast`,
      Object.keys(body).length ? body : { steps: 6 },
    );
  },
};

export async function fetchRadarForecast(
  client: Pick<BackendClient, "call">,
  sessionId: string,
  options?: { steps?: number; cursor?: number },
): Promise<BackendResult> {
  const body: Record<string, unknown> = { steps: options?.steps ?? 6 };
  if (options?.cursor !== undefined) body.cursor = options.cursor;
  return client.call(
    "POST",
    `/api/intelligence/radar/sessions/${encodeURIComponent(sessionId)}/forecast`,
    body,
  );
}

export const RADAR_TOOLS: Tool[] = [radarForecastTool];
