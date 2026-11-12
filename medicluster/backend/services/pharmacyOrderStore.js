/**
 * backend/services/pharmacyOrderStore.js
 * Order persistence, state machine application, effects processing, and projection.
 */

const crypto = require("node:crypto");
const PharmacyOrder = require("../models/PharmacyOrder");
const PharmacyStock = require("../models/PharmacyStock");
const Delivery = require("../models/Delivery");
const Prescription = require("../models/Prescription");
const PharmacyOrderOtp = require("../models/PharmacyOrderOtp");
const { transition, hashOtp, otpMatches } = require("./pharmacyOrders");

const _testOtps = new Map();

function _getTestOtp(orderId) {
  return _testOtps.get(String(orderId)) || null;
}

async function _setTestOtp(orderId, otp, patientId) {
  _testOtps.set(String(orderId), otp);
  if (patientId) {
    await PharmacyOrderOtp.deleteMany({ orderId: String(orderId) });
    await PharmacyOrderOtp.create({
      orderId: String(orderId),
      patientId: String(patientId),
      otp: String(otp),
    });
  }
}

function publicOrder(order, viewerKind) {
  if (!order) return null;
  const raw = order.toObject ? order.toObject() : { ...order };
  delete raw.handoverOtpHash;
  delete raw.otpAttempts;

  if (viewerKind === "courier") {
    return {
      _id: raw._id,
      status: raw.status,
      fulfilment: raw.fulfilment,
      deliveryAddress: raw.deliveryAddress,
      pharmacyId: raw.pharmacyId,
      patientFirstName: raw.patientFirstName || (raw.patientName ? raw.patientName.split(" ")[0] : undefined),
      patientPhone: raw.patientPhone || undefined,
    };
  }

  return raw;
}

async function applyAction(orderId, action, actor, input = {}) {
  const existing = await PharmacyOrder.findById(orderId).select("+handoverOtpHash");
  if (!existing) {
    const err = new Error("Order not found");
    err.status = 404;
    throw err;
  }

  const orderObj = existing.toObject ? existing.toObject() : { ...existing };

  // Handle OTP verification before transition
  if (action === "handover" || (action === "deliver" && input?.otp)) {
    const attempts = orderObj.otpAttempts || 0;
    if (attempts >= 5) {
      const err = new Error("Too many failed attempts");
      err.status = 429;
      throw err;
    }

    const matches = otpMatches(input.otp, orderObj.handoverOtpHash);
    if (!matches) {
      const newAttempts = attempts + 1;
      await PharmacyOrder.findByIdAndUpdate(orderObj._id, { otpAttempts: newAttempts });
      const err = new Error("Wrong code");
      err.status = 400;
      throw err;
    }
  }

  const { order: transitionedOrder, effects } = transition(orderObj, action, actor, input);

  let generatedOtp = null;
  const stockWarnings = [];

  for (const effect of effects) {
    if (effect.type === "generate_otp") {
      const plainOtp = String(crypto.randomInt(0, 10000)).padStart(4, "0");
      generatedOtp = plainOtp;
      transitionedOrder.handoverOtpHash = hashOtp(plainOtp);
      transitionedOrder.otpAttempts = 0;
      _testOtps.set(String(transitionedOrder._id), plainOtp);
      await PharmacyOrderOtp.deleteMany({ orderId: String(transitionedOrder._id) });
      await PharmacyOrderOtp.create({
        orderId: String(transitionedOrder._id),
        patientId: String(transitionedOrder.patientId),
        otp: plainOtp,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    } else if (effect.type === "decrement_stock") {
      const stocks = await PharmacyStock.find({ pharmacyId: String(transitionedOrder.pharmacyId) }).lean();
      for (const item of (effect.items || [])) {
        const itemDrug = String(item.drug || "").trim().toLowerCase();
        const stock = stocks.find(s => String(s.drug || "").trim().toLowerCase() === itemDrug);
        if (!stock || stock.quantity < item.quantity) {
          stockWarnings.push({
            drug: item.drug,
            requested: item.quantity,
            available: stock ? stock.quantity : 0,
            warning: `Low/insufficient stock for ${item.drug}`,
          });
        }
        if (stock) {
          const newQty = Math.max(0, stock.quantity - item.quantity);
          await PharmacyStock.findByIdAndUpdate(stock._id, { quantity: newQty });
        }
      }
    } else if (effect.type === "create_delivery") {
      await Delivery.create({
        orderId: String(transitionedOrder._id),
        courierId: String(effect.courierId),
        status: "assigned",
      });
    } else if (effect.type === "close_delivery") {
      const delivery = await Delivery.findOne({ orderId: String(transitionedOrder._id) }).lean();
      if (delivery) {
        const update = { status: effect.status };
        if (effect.status === "delivered") {
          update.proof = effect.photoMediaId
            ? { kind: "photo", at: new Date(), mediaId: effect.photoMediaId }
            : { kind: "otp", at: new Date() };
        }
        await Delivery.findByIdAndUpdate(delivery._id, update);
      }
    }
  }

  // Update prescription if fulfilled
  if (
    (transitionedOrder.status === "picked_up" || transitionedOrder.status === "delivered") &&
    transitionedOrder.source?.type === "prescription" &&
    transitionedOrder.source?.prescriptionId
  ) {
    await Prescription.findByIdAndUpdate(transitionedOrder.source.prescriptionId, { status: "fulfilled" });
  }

  if (["picked_up", "delivered", "cancelled"].includes(transitionedOrder.status)) {
    await PharmacyOrderOtp.deleteMany({ orderId: String(transitionedOrder._id) });
    _testOtps.delete(String(transitionedOrder._id));
  }

  const saved = await PharmacyOrder.findByIdAndUpdate(
    transitionedOrder._id,
    transitionedOrder,
    { new: true }
  ).lean();

  return {
    order: saved,
    otp: generatedOtp,
    ...(stockWarnings.length > 0 ? { stockWarnings } : {}),
  };
}

module.exports = {
  applyAction,
  publicOrder,
  _getTestOtp,
  _setTestOtp,
};
