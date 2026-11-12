/**
 * backend/models/Delivery.js
 * Courier delivery tracking for prescription and refill orders.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const DELIVERY_STATUSES = ["assigned", "accepted", "picked_up", "delivered", "failed"];

const LocationSchema = defineSchema({
  lat:        { type: Number, required: true },
  lng:        { type: Number, required: true },
  accuracy:   { type: Number, default: null },
  observedAt: { type: Date, default: Date.now },
}, { _id: false });

const ProofSchema = defineSchema({
  kind:    { type: String, enum: ["otp", "photo"], required: true },
  at:      { type: Date, default: Date.now },
  mediaId: { type: String, default: null },
}, { _id: false });

const DeliverySchema = defineSchema(
  {
    orderId:      { type: String, required: true, index: true },
    courierId:    { type: String, required: true, index: true },
    status:       { type: String, default: "assigned", enum: DELIVERY_STATUSES },
    lastLocation: { type: LocationSchema, default: null },
    proof:        { type: ProofSchema, default: null },
  },
  { timestamps: true }
);

module.exports = defineModel("Delivery", DeliverySchema);
module.exports.DELIVERY_STATUSES = DELIVERY_STATUSES;
