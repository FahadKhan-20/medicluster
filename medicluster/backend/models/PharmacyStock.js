/**
 * backend/models/PharmacyStock.js
 * Pharmacy inventory row per medication/strength/batch.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const PharmacyStockSchema = defineSchema(
  {
    pharmacyId:        { type: String, required: true, index: true },
    drug:              { type: String, required: true, trim: true },
    strength:          { type: String, default: "" },
    barcode:           { type: String, default: "" },
    quantity:          { type: Number, default: 0 },
    batch:             { type: String, default: "" },
    expiry:            { type: String, default: "" },
    lowStockThreshold: { type: Number, default: 10 },
  },
  { timestamps: true }
);

module.exports = defineModel("PharmacyStock", PharmacyStockSchema);
