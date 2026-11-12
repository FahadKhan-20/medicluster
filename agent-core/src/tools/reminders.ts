// Reminder tools: actions the agent can take for medication reminders.
import type { BackendClient, BackendResult } from "./backend.js";
import { validateArgs, type PropSchema, type Tool, type ToolSchema } from "./registry.js";

export type ReminderToolResult = BackendResult;

const ID_PATTERN = "^[a-zA-Z0-9_-]{1,128}$";
const idProp: PropSchema = { type: "string", pattern: ID_PATTERN };

export const REMINDER_NOTIFY_PROPS: Record<string, PropSchema> = {
  reminder_id: idProp,
  patient_id: idProp,
  date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
  message: { type: "string", minLength: 1, maxLength: 2000 },
  audit_id: { type: "string", minLength: 1, maxLength: 200 },
};

export const REMINDER_ALERT_PROPS: Record<string, PropSchema> = {
  patient_id: { type: "string", minLength: 1 },
  source_id: { type: "string", minLength: 1 },
  severity: { type: "string", enum: ["WARNING", "HIGH", "CRITICAL"] },
  title: { type: "string", minLength: 1, maxLength: 200 },
  summary: { type: "string", minLength: 1, maxLength: 2000 },
  jev_probabilities: { type: "object", maxJsonLength: 4000 },
  audit_id: { type: "string", minLength: 1 },
};

function defineReminderTool(spec: {
  name: string;
  group: any;
  action: any;
  schema: ToolSchema;
  exec(args: Record<string, unknown>, client: BackendClient): Promise<ReminderToolResult>;
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

export const reminderNotifyTool: Tool = defineReminderTool({
  name: "reminders.notify",
  group: "reminders",
  action: "notify_patient",
  schema: {
    type: "object",
    properties: REMINDER_NOTIFY_PROPS,
    required: ["reminder_id", "patient_id", "date", "time", "message", "audit_id"],
    additionalProperties: false,
  },
  exec: (args, client) => {
    const reminderId = encodeURIComponent(String(args.reminder_id));
    return client.call("POST", `/api/reminders/${reminderId}/notify`, {
      reminder_id: args.reminder_id,
      patient_id: args.patient_id,
      date: args.date,
      time: args.time,
      message: args.message,
      audit_id: args.audit_id,
    });
  },
});

export const reminderAlertTool: Tool = defineReminderTool({
  name: "alerts.create",
  group: "reminders",
  action: "escalate_alert",
  schema: {
    type: "object",
    properties: REMINDER_ALERT_PROPS,
    required: ["patient_id", "source_id", "severity", "title", "summary", "jev_probabilities", "audit_id"],
    additionalProperties: false,
  },
  exec: (args, client) =>
    client.call(
      "POST",
      "/api/alerts/agent",
      Object.fromEntries(Object.keys(REMINDER_ALERT_PROPS).map((k) => [k, args[k]])),
    ),
});

export const REMINDER_TOOLS: Tool[] = [reminderNotifyTool, reminderAlertTool];

export function toolForReminderAction(action: string): Tool | undefined {
  return REMINDER_TOOLS.find((t) => t.action === action);
}
