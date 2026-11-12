/**
 * backend/models/PharmacyOrder.js
 * Pharmacy medication order for pickup or delivery.
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const OrderItemSchema = defineSchema({
  drug:          { type: String, required: true, trim: true },
  strength:      { type: String, default: "" },
  form:          { type: String, default: "" },
  dose:          { type: String, default: "" },
  frequency:     { type: String, default: "" },
  durationDays:  { type: Number, default: null },
  quantity:      { type: Number, required: true },
  instructions:  { type: String, default: "" },
}, { _id: false });

const StatusHistorySchema = defineSchema({
  status: { type: String, required: true },
  at:     { type: Date, default: Date.now },
  byKind: { type: String, default: "" },
  byId:   { type: String, default: "" },
  note:   { type: String, default: "" },
}, { _id: false });

const DeliveryAddressSchema = defineSchema({
  text: { type: String, default: "" },
  lat:  { type: Number, default: null },
  lng:  { type: Number, default: null },
}, { _id: false });

const SourceSchema = defineSchema({
  type:           { type: String, required: true },
  prescriptionId: { type: String, default: null },
  reminderId:     { type: String, default: null },
}, { _id: false });

const ORDER_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "rejected",
  "cancelled",
];

const PharmacyOrderSchema = defineSchema(
  {
    patientId:       { type: String, required: true, index: true },
    patientName:     { type: String, default: "" },
    patientPhone:    { type: String, default: "" },
    pharmacyId:      { type: String, required: true, index: true },
    source:          { type: SourceSchema, required: true },
    items:           { type: [OrderItemSchema], default: [] },
    fulfilment:      { type: String, required: true, enum: ["pickup", "delivery"] },
    deliveryAddress: { type: DeliveryAddressSchema, default: null },
    status:          { type: String, default: "new", enum: ORDER_STATUSES },
    statusHistory:   { type: [StatusHistorySchema], default: [] },
    rejectReason:    { type: String, default: "" },
    handoverOtpHash: { type: String, select: false, default: null },
    otpAttempts:     { type: Number, default: 0 },
    courierId:       { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = defineModel("PharmacyOrder", PharmacyOrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
