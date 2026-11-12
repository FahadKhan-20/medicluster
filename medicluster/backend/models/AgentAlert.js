/**
 * backend/models/AgentAlert.js
 * An alert raised by the autonomous agent-core service. Jev decides; this stores the outcome.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const AgentAlertSchema = defineSchema(
  {
    patient_id:        { type: String, required: true, index: true },
    source_id:         { type: String, required: true },
    severity:          { type: String, enum: ["WARNING", "HIGH", "CRITICAL"], required: true },
    title:             { type: String, required: true },
    summary:           { type: String, required: true },
    jev_probabilities: { type: Object, default: {} },
    audit_id:          { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = defineModel("AgentAlert", AgentAlertSchema, { collection: "agentalerts" });
