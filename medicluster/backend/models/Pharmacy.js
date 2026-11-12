/**
 * backend/models/Pharmacy.js
 * Pharmacy partner profile and location.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const PharmacySchema = defineSchema(
  {
    name:    { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    lat:     { type: Number, default: null },
    lng:     { type: Number, default: null },
    phone:   { type: String, default: "" },
    active:  { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = defineModel("Pharmacy", PharmacySchema);
