/**
 * backend/models/RefillSuggestion.js
 * AI agent refill suggestion requiring clinician confirmation.
 * Never creates an order or prescription directly.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const RefillSuggestionSchema = defineSchema(
  {
    patientId:  { type: String, required: true, index: true },
    drug:       { type: String, required: true },
    dose:       { type: String, default: "" },
    reason:     { type: String, default: "" },
    confidence: { type: Number, default: null },
    status:     {
      type: String,
      default: "pending_clinician_approval",
      enum: ["pending_clinician_approval", "approved", "rejected"],
    },
  },
  { timestamps: true }
);

module.exports = defineModel("RefillSuggestion", RefillSuggestionSchema);
