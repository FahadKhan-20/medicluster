/**
 * backend/routes/courierRoutes.js
 * Courier delivery actions, location telemetry, and active drop-off confirmation.
 */

const express = require("express");
const Delivery = require("../models/Delivery");
const PharmacyOrder = require("../models/PharmacyOrder");
const Pharmacy = require("../models/Pharmacy");
const { applyAction, publicOrder } = require("../services/pharmacyOrderStore");
const { isValidId } = require("../db/ids");

const router = express.Router();

// GET /api/courier/deliveries?status=
router.get("/deliveries", async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { courierId: String(req.staff.id) };
    if (status) {
      filter.status = String(status);
    }

    const deliveries = await Delivery.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.json(deliveries);
  } catch (err) {
    return next(err);
  }
});

// GET /api/courier/deliveries/:id
router.get("/deliveries/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid delivery id" });
    }

    const delivery = await Delivery.findById(req.params.id).lean();
    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (String(delivery.courierId) !== String(req.staff.id)) {
      return res.status(403).json({ error: "Access to this delivery is forbidden" });
    }

    const order = await PharmacyOrder.findById(delivery.orderId).lean();
    const pharmacy = order ? await Pharmacy.findById(order.pharmacyId).lean() : null;

    return res.json({
      delivery,
      order: publicOrder(order, "courier"),
      pharmacy,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/courier/deliveries/:id/accept
router.post("/deliveries/:id/accept", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid delivery id" });
    }

    const delivery = await Delivery.findById(req.params.id).lean();
    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (String(delivery.courierId) !== String(req.staff.id)) {
      return res.status(403).json({ error: "Access to this delivery is forbidden" });
    }

    if (delivery.status !== "assigned") {
      return res.status(409).json({ error: `Cannot accept delivery in status ${delivery.status}` });
    }

    const updated = await Delivery.findByIdAndUpdate(
      req.params.id,
      { status: "accepted" },
      { new: true }
    ).lean();

    return res.json({ delivery: updated });
  } catch (err) {
    return next(err);
  }
});

// POST /api/courier/deliveries/:id/actions
router.post("/deliveries/:id/actions", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid delivery id" });
    }

    const delivery = await Delivery.findById(req.params.id).lean();
    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (String(delivery.courierId) !== String(req.staff.id)) {
      return res.status(403).json({ error: "Access to this delivery is forbidden" });
    }

    const { action, otp, photoMediaId, reason } = req.body || {};
    const actionMap = {
      pickup: "courier_pickup",
      deliver: "deliver",
      fail: "fail",
    };

    const mappedAction = actionMap[action];
    if (!mappedAction) {
      return res.status(400).json({ error: `Unsupported courier action: ${action}` });
    }

    const actor = {
      kind: "courier",
      id: req.staff.id,
    };

    const result = await applyAction(delivery.orderId, mappedAction, actor, { otp, photoMediaId, reason });

    // Update delivery status to match order transition
    const update = {};
    if (mappedAction === "courier_pickup") {
      update.status = "picked_up";
    } else if (mappedAction === "deliver") {
      update.status = "delivered";
      update.proof = photoMediaId
        ? { kind: "photo", at: new Date(), mediaId: photoMediaId }
        : { kind: "otp", at: new Date() };
    } else if (mappedAction === "fail") {
      update.status = "failed";
    }

    const updatedDelivery = await Delivery.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    ).lean();

    return res.json({
      delivery: updatedDelivery,
      order: publicOrder(result.order, "courier"),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/courier/deliveries/:id/location
router.post("/deliveries/:id/location", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid delivery id" });
    }

    const delivery = await Delivery.findById(req.params.id).lean();
    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (String(delivery.courierId) !== String(req.staff.id)) {
      return res.status(403).json({ error: "Access to this delivery is forbidden" });
    }

    const { lat, lng, accuracy, observedAt } = req.body || {};

    if (typeof lat !== "number" || lat < -90 || lat > 90) {
      return res.status(400).json({ error: "lat must be a number between -90 and 90" });
    }
    if (typeof lng !== "number" || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "lng must be a number between -180 and 180" });
    }

    const obsDate = new Date(observedAt);
    if (!observedAt || Number.isNaN(obsDate.getTime())) {
      return res.status(400).json({ error: "observedAt must be a valid ISO date" });
    }

    if (delivery.status !== "accepted" && delivery.status !== "picked_up") {
      return res.status(409).json({ error: "Location updates are only allowed while delivery is accepted or picked up" });
    }

    // Ignore older or identical location fix
    if (delivery.lastLocation?.observedAt) {
      const existingDate = new Date(delivery.lastLocation.observedAt);
      if (obsDate.getTime() <= existingDate.getTime()) {
        return res.status(204).end();
      }
    }

    const updated = await Delivery.findByIdAndUpdate(
      req.params.id,
      {
        lastLocation: {
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
          observedAt: obsDate,
        },
      },
      { new: true }
    ).lean();

    return res.json({ delivery: updated });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
