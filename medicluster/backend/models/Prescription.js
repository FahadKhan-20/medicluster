/**
 * backend/models/Prescription.js
 * Digital prescription issued by a clinician.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const PrescriptionItemSchema = defineSchema({
  drug:          { type: String, required: true, trim: true },
  strength:      { type: String, default: "" },
  form:          { type: String, default: "" },
  dose:          { type: String, default: "" },
  frequency:     { type: String, default: "" },
  durationDays:  { type: Number, default: null },
  quantity:      { type: Number, required: true },
  instructions:  { type: String, default: "" },
}, { _id: false });

const PrescriptionSchema = defineSchema(
  {
    patientId:    { type: String, required: true, index: true },
    doctorUserId: { type: String, required: true },
    items:        { type: [PrescriptionItemSchema], required: true },
    notes:        { type: String, default: "" },
    status:       { type: String, enum: ["active", "fulfilled", "cancelled"], default: "active" },
    pharmacyId:   { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = defineModel("Prescription", PrescriptionSchema);
