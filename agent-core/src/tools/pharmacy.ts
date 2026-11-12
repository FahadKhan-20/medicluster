// Pharmacy tools: actions the agent can take for pharmacy ops (stock, stuck orders, refill suggestions).
import type { BackendClient, BackendResult } from "./backend.js";
import { validateArgs, type PropSchema, type Tool, type ToolSchema } from "./registry.js";

export type PharmacyToolResult = BackendResult;

export interface StockItem {
  pharmacyId: string;
  drug: string;
  strength: string;
  quantity: number;
  lowStockThreshold: number;
  barcode?: string;
  batch?: string;
  expiry?: string;
  [key: string]: unknown;
}

export interface StockLowResponse {
  items: StockItem[];
}

export interface StuckOrderItem {
  orderId: string;
  pharmacyId: string;
  patientId: string;
  status: string;
  items?: Array<{ drug: string; quantity: number; [key: string]: unknown }>;
  fulfilment?: "pickup" | "delivery";
  hoursInCurrentState?: number;
  stuckMinutes?: number;
  createdAt?: string;
  updatedAt?: string;
  stuckReason?: string;
  [key: string]: unknown;
}

export interface StuckOrdersResponse {
  items: StuckOrderItem[];
}

export interface RefillSuggestionArgs {
  patientId: string;
  reminderId: string;
  medicationName: string;
  dosage: string;
  reason: string;
  auditId: string;
  suggestedAction?: string;
  idemKey?: string;
  [key: string]: unknown;
}

export interface PharmacyAlertArgs {
  patient_id: string;
  source_id: string;
  severity: "WARNING" | "HIGH" | "CRITICAL";
  title: string;
  summary: string;
  jev_probabilities: Record<string, unknown>;
  audit_id: string;
  idem_key?: string;
  [key: string]: unknown;
}

const ID_PATTERN = "^[a-zA-Z0-9_:-]{1,128}$";
const idProp: PropSchema = { type: "string", pattern: ID_PATTERN };

export const REFILL_SUGGESTION_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    patientId: idProp,
    reminderId: idProp,
    medicationName: { type: "string", minLength: 1, maxLength: 200 },
    dosage: { type: "string", minLength: 1, maxLength: 100 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    auditId: idProp,
    suggestedAction: { type: "string", minLength: 1, maxLength: 100 },
    idemKey: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["patientId", "reminderId", "medicationName", "dosage", "reason", "auditId"],
  additionalProperties: false,
};

export const PHARMACY_ALERT_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    patient_id: { type: "string", minLength: 1, maxLength: 128 },
    source_id: { type: "string", minLength: 1, maxLength: 128 },
    severity: { type: "string", enum: ["WARNING", "HIGH", "CRITICAL"] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    jev_probabilities: { type: "object", maxJsonLength: 4000 },
    audit_id: { type: "string", minLength: 1, maxLength: 128 },
    idem_key: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["patient_id", "source_id", "severity", "title", "summary", "jev_probabilities", "audit_id"],
  additionalProperties: false,
};

export const EMPTY_SCHEMA: ToolSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

function definePharmacyTool(spec: {
  name: string;
  group: any;
  action: any;
  schema: ToolSchema;
  exec(args: Record<string, unknown>, client: BackendClient): Promise<PharmacyToolResult>;
}): Tool {
  const tool: Tool = {
    name: spec.name,
    group: spec.group,
    action: spec.action,
    schema: spec.schema,
    async run(args, client) {
      const errors = validateArgs(tool, args);
      if (errors.length) {
        return { ok: false, status: 0, error: `invalid arguments: ${errors.join("; ")}`, retryable: false };
      }
      return spec.exec(args, client);
    },
  };
  return tool;
}

export const pharmacyRefillSuggestionTool: Tool = definePharmacyTool({
  name: "pharmacy.refill_suggestion",
  group: "pharmacy",
  action: "suggest_refill",
  schema: REFILL_SUGGESTION_SCHEMA,
  exec: (args, client) => {
    return client.call("POST", "/api/pharmacy/agent/refill-suggestion", {
      patientId: args.patientId,
      reminderId: args.reminderId,
      medicationName: args.medicationName,
      dosage: args.dosage,
      reason: args.reason,
      auditId: args.auditId,
      suggestedAction: args.suggestedAction ?? "refill_suggestion",
      ...(args.idemKey ? { idemKey: args.idemKey } : {}),
    });
  },
});

export const pharmacyAlertTool: Tool = definePharmacyTool({
  name: "pharmacy.alert",
  group: "pharmacy",
  action: "alert",
  schema: PHARMACY_ALERT_SCHEMA,
  exec: (args, client) =>
    client.call(
      "POST",
      "/api/alerts/agent",
      Object.fromEntries(
        Object.keys(PHARMACY_ALERT_SCHEMA.properties)
          .filter((k) => args[k] !== undefined)
          .map((k) => [k, args[k]]),
      ),
    ),
});

export const pharmacyStockLowTool: Tool = definePharmacyTool({
  name: "pharmacy.stock_low",
  group: "pharmacy",
  action: "query",
  schema: EMPTY_SCHEMA,
  exec: (_args, client) => client.call("GET", "/api/pharmacy/agent/stock-low"),
});

export const pharmacyStuckOrdersTool: Tool = definePharmacyTool({
  name: "pharmacy.stuck_orders",
  group: "pharmacy",
  action: "query",
  schema: EMPTY_SCHEMA,
  exec: (_args, client) => client.call("GET", "/api/pharmacy/agent/stuck-orders"),
});

export const PHARMACY_TOOLS: Tool[] = [
  pharmacyRefillSuggestionTool,
  pharmacyAlertTool,
  pharmacyStockLowTool,
  pharmacyStuckOrdersTool,
];

/** Helper to query low stock items from backend. */
export async function fetchLowStock(
  client: Pick<BackendClient, "call">,
): Promise<BackendResult> {
  return client.call("GET", "/api/pharmacy/agent/stock-low");
}

/** Helper to query stuck orders from backend. */
export async function fetchStuckOrders(
  client: Pick<BackendClient, "call">,
): Promise<BackendResult> {
  return client.call("GET", "/api/pharmacy/agent/stuck-orders");
}

/** Helper to post a refill suggestion. */
export async function postRefillSuggestion(
  client: Pick<BackendClient, "call">,
  args: RefillSuggestionArgs,
): Promise<BackendResult> {
  return client.call("POST", "/api/pharmacy/agent/refill-suggestion", args);
}

/** Helper to post an agent alert. */
export async function postPharmacyAlert(
  client: Pick<BackendClient, "call">,
  args: PharmacyAlertArgs,
): Promise<BackendResult> {
  return client.call("POST", "/api/alerts/agent", args);
}
