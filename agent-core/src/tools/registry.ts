// Tool registry: the only actions the agent can take. Schemas mirror the backend route limits.
import type { BackendClient, BackendResult } from "./backend.js";

export type ToolResult = BackendResult;
export type ToolGroup = "imaging" | "alerts";
export type ToolAction = "analyze" | "request_review" | "alert";

export type PropSchema = {
  type: "string" | "object";
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  /** For objects: maximum length of the JSON serialization. */
  maxJsonLength?: number;
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, PropSchema>;
  required: string[];
  additionalProperties: false;
};

export type Tool = {
  name: string;
  group: ToolGroup;
  action: ToolAction;
  schema: ToolSchema;
  run(args: Record<string, unknown>, client: BackendClient): Promise<ToolResult>;
};

const ID_PATTERN = "^[a-zA-Z0-9_-]{1,128}$";
const fileIdProp: PropSchema = { type: "string", pattern: ID_PATTERN };

export function validateArgs(tool: Tool, args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["args must be an object"];
  const a = args as Record<string, unknown>;
  const { properties, required } = tool.schema;
  const errors: string[] = [];
  for (const k of Object.keys(a)) if (!Object.hasOwn(properties, k)) errors.push(`unexpected argument: ${k}`);
  for (const k of required) if (a[k] === undefined) errors.push(`missing required argument: ${k}`);
  for (const [k, p] of Object.entries(properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (p.type === "string") {
      if (typeof v !== "string") {
        errors.push(`${k} must be a string`);
        continue;
      }
      if (p.minLength !== undefined && v.length < p.minLength) errors.push(`${k} must be at least ${p.minLength} characters`);
      if (p.maxLength !== undefined && v.length > p.maxLength) errors.push(`${k} must be at most ${p.maxLength} characters`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) errors.push(`${k} has invalid format`);
      if (p.enum && !p.enum.includes(v)) errors.push(`${k} must be one of: ${p.enum.join(", ")}`);
    } else {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        errors.push(`${k} must be an object`);
        continue;
      }
      if (p.maxJsonLength !== undefined && JSON.stringify(v).length > p.maxJsonLength) {
        errors.push(`${k} must serialize to at most ${p.maxJsonLength} characters`);
      }
    }
  }
  return errors;
}

const ALERT_PROPS: Record<string, PropSchema> = {
    patient_id: { type: "string", minLength: 1 },
    source_id: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["WARNING", "HIGH", "CRITICAL"] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    jev_probabilities: { type: "object", maxJsonLength: 4000 },
    audit_id: { type: "string", minLength: 1 },
    idem_key: { type: "string", minLength: 1, maxLength: 256 },
};

type ToolSpec = Omit<Tool, "run"> & { exec(args: Record<string, unknown>, client: BackendClient): Promise<ToolResult> };

/** Every tool validates its own arguments before touching the network. */
function defineTool(spec: ToolSpec): Tool {
  const { exec, ...rest } = spec;
  const tool: Tool = {
    ...rest,
    async run(args, client) {
      const errors = validateArgs(tool, args);
      if (errors.length) {
        return { ok: false, status: 0, error: `invalid arguments: ${errors.join("; ")}`, retryable: false };
      }
      return exec(args, client);
    },
  };
  return tool;
}

export const TOOLS: Tool[] = ([
  {
    name: "imaging.analyze",
    group: "imaging",
    action: "analyze",
    schema: {
      type: "object",
      properties: { fileId: fileIdProp, model_name: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["fileId"],
      additionalProperties: false,
    },
    exec: (args, client) => {
      const body = typeof args.model_name === "string" ? { model_name: args.model_name } : undefined;
      return client.call("POST", `/api/media/analyze/${encodeURIComponent(String(args.fileId))}`, body);
    },
  },
  {
    name: "imaging.request_review",
    group: "imaging",
    action: "request_review",
    schema: {
      type: "object",
      properties: { fileId: fileIdProp },
      required: ["fileId"],
      additionalProperties: false,
    },
    exec: (args, client) => client.call("POST", `/api/media/review/${encodeURIComponent(String(args.fileId))}`),
  },
  {
    name: "alerts.create",
    group: "alerts",
    action: "alert",
    schema: {
      type: "object",
      properties: ALERT_PROPS,
      required: ["patient_id", "source_id", "severity", "title", "summary", "jev_probabilities", "audit_id"],
      additionalProperties: false,
    },
    exec: (args, client) =>
      client.call(
        "POST",
        "/api/alerts/agent",
        Object.fromEntries(Object.keys(ALERT_PROPS).filter((k) => args[k] !== undefined).map((k) => [k, args[k]])),
      ),
  },
] as ToolSpec[]).map(defineTool);

export const toolForAction = (action: string): Tool | undefined => TOOLS.find((t) => t.action === action);

export const listModels = (client: BackendClient): Promise<BackendResult> => client.call("GET", "/api/media/models");
