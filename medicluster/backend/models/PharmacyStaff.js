/**
 * backend/models/PharmacyStaff.js
 * Pharmacists and couriers with role-scoped credentials.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const ROLES = ["pharmacist", "courier"];

const PharmacyStaffSchema = defineSchema(
  {
    name:         { type: String, required: true, trim: true },
    role:         { type: String, required: true, enum: ROLES },
    email:        { type: String, lowercase: true, trim: true },
    phone:        { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    pharmacyIds:  { type: [String], default: [] },
    active:       { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = defineModel("PharmacyStaff", PharmacyStaffSchema);
module.exports.ROLES = ROLES;
