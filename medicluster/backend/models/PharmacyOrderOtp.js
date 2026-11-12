/**
 * backend/models/PharmacyOrderOtp.js
 * Plaintext OTP stored temporarily for patient handover retrieval, deleted on completion.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const PharmacyOrderOtpSchema = defineSchema(
  {
    orderId:   { type: String, required: true, index: true },
    patientId: { type: String, required: true, index: true },
    otp:       { type: String, required: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = defineModel("PharmacyOrderOtp", PharmacyOrderOtpSchema);
