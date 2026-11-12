/**
 * backend/models/EcgRecord.js
 * 12-lead ECG records uploaded by clinicians or emergency crew.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const EcgRecordSchema = defineSchema(
  {
    patient_id: { type: String, required: true, index: true },
    signal: { type: Array, required: true }, // 12 x 1000 numbers in mV
    lead_order: { type: Array, default: () => ['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'] },
    sample_rate: { type: Number, default: 100 },
    duration_seconds: { type: Number, default: 10 },
    device: { type: String, default: '12-lead ECG' },
    recordedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['uploaded', 'analyzed', 'reviewed'], default: 'uploaded' },
    analysis: {
      probabilities: Object,
      top: String,
      model: String,
      warning: String,
      analyzedAt: Date,
    },
    uploadedBy: { type: String },
  },
  { timestamps: true, collection: 'ecgrecords' }
);

module.exports = defineModel("EcgRecord", EcgRecordSchema, { collection: 'ecgrecords' });
