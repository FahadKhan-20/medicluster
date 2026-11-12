/**
 * backend/routes/patientPharmacyRoutes.js
 * Patient-app routes for prescriptions, pharmacy directory, and medication orders.
 */

const express = require("express");
const { requirePatientOrClinician, canAccessPatient } = require("../middleware/auth");
const Pharmacy = require("../models/Pharmacy");
const Prescription = require("../models/Prescription");
const PharmacyOrder = require("../models/PharmacyOrder");
const PharmacyOrderOtp = require("../models/PharmacyOrderOtp");
const Delivery = require("../models/Delivery");
const Reminder = require("../models/Reminder");
const PatientProfile = require("../models/PatientProfile");
const { applyAction, publicOrder, _getTestOtp } = require("../services/pharmacyOrderStore");
const { isValidId } = require("../db/ids");

const router = express.Router();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

router.use(requirePatientOrClinician);

router.use("/:patientId", (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  if (!canAccessPatient(req, req.params.patientId)) {
    return res.status(403).json({ error: "Not your record" });
  }
  next();
});

// GET /api/patient-app/:patientId/prescriptions
router.get("/:patientId/prescriptions", async (req, res, next) => {
  try {
    const list = await Prescription.find({ patientId: req.params.patientId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json(list);
  } catch (err) {
    return next(err);
  }
});

// GET /api/patient-app/:patientId/pharmacies?lat=&lng=
router.get("/:patientId/pharmacies", async (req, res, next) => {
  try {
    const { lat, lng } = req.query;
    const hasCoords = lat !== undefined && lng !== undefined && lat !== "" && lng !== "" &&
      !isNaN(Number(lat)) && !isNaN(Number(lng));

    const pharmacies = await Pharmacy.find({ active: true }).lean();

    if (hasCoords) {
      const userLat = Number(lat);
      const userLng = Number(lng);
      const withDistance = pharmacies.map(p => {
        const dist = (p.lat != null && p.lng != null)
          ? haversineKm(userLat, userLng, p.lat, p.lng)
          : Infinity;
        return { ...p, distanceKm: dist };
      });
      withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
      return res.json(withDistance);
    }

    pharmacies.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return res.json(pharmacies);
  } catch (err) {
    return next(err);
  }
});

// POST /api/patient-app/:patientId/orders
router.post("/:patientId/orders", async (req, res, next) => {
  try {
    const { source, pharmacyId, fulfilment, deliveryAddress } = req.body || {};
    if (!source || typeof source !== "object") {
      return res.status(400).json({ error: "source is required" });
    }
    if (!pharmacyId) {
      return res.status(400).json({ error: "pharmacyId is required" });
    }

    const pharmacy = await Pharmacy.findById(pharmacyId).lean();
    if (!pharmacy || !pharmacy.active) {
      return res.status(400).json({ error: "Unknown or inactive pharmacy" });
    }

    if (!["pickup", "delivery"].includes(fulfilment)) {
      return res.status(400).json({ error: "fulfilment must be 'pickup' or 'delivery'" });
    }

    if (fulfilment === "delivery") {
      if (
        !deliveryAddress ||
        typeof deliveryAddress !== "object" ||
        typeof deliveryAddress.text !== "string" ||
        !deliveryAddress.text.trim() ||
        typeof deliveryAddress.lat !== "number" ||
        typeof deliveryAddress.lng !== "number" ||
        deliveryAddress.lat < -90 || deliveryAddress.lat > 90 ||
        deliveryAddress.lng < -180 || deliveryAddress.lng > 180
      ) {
        return res.status(400).json({ error: "Valid deliveryAddress with text and lat/lng coordinates is required" });
      }
    }

    let items = [];
    if (source.type === "prescription") {
      if (!source.prescriptionId) {
        return res.status(400).json({ error: "prescriptionId is required for prescription source" });
      }
      const prescription = await Prescription.findOne({
        _id: String(source.prescriptionId),
        patientId: req.params.patientId,
      }).lean();
      if (!prescription) {
        return res.status(400).json({ error: "Prescription not found" });
      }
      if (prescription.status !== "active") {
        return res.status(400).json({ error: "Prescription is not active" });
      }
      items = (prescription.items || []).map(it => ({
        drug: it.drug,
        strength: it.strength || "",
        form: it.form || "",
        dose: it.dose || "",
        frequency: it.frequency || "",
        durationDays: it.durationDays || null,
        quantity: it.quantity || 1,
        instructions: it.instructions || "",
      }));
    } else if (source.type === "refill") {
      if (!source.reminderId) {
        return res.status(400).json({ error: "reminderId is required for refill source" });
      }
      const reminder = await Reminder.findOne({
        _id: String(source.reminderId),
        patientId: req.params.patientId,
      }).lean();
      if (!reminder) {
        return res.status(400).json({ error: "Reminder not found" });
      }
      items = [{
        drug: reminder.medicationName,
        dose: reminder.dosage || "",
        quantity: 1,
      }];
    } else {
      return res.status(400).json({ error: "source.type must be 'prescription' or 'refill'" });
    }

    const profile = await PatientProfile.findOne({ patientId: req.params.patientId }).lean();

    const order = await PharmacyOrder.create({
      patientId: req.params.patientId,
      patientName: profile?.name || "",
      patientPhone: profile?.mobile || "",
      pharmacyId: String(pharmacy._id),
      source: {
        type: source.type,
        prescriptionId: source.prescriptionId ? String(source.prescriptionId) : null,
        reminderId: source.reminderId ? String(source.reminderId) : null,
      },
      items,
      fulfilment,
      deliveryAddress: fulfilment === "delivery" ? {
        text: deliveryAddress.text.trim(),
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
      } : null,
      status: "new",
      statusHistory: [{
        status: "new",
        at: new Date(),
        byKind: req.session?.kind || "patient",
        byId: String(req.session?.sub || req.params.patientId),
      }],
    });

    return res.status(201).json(publicOrder(order, "patient"));
  } catch (err) {
    return next(err);
  }
});

// GET /api/patient-app/:patientId/orders
router.get("/:patientId/orders", async (req, res, next) => {
  try {
    const orders = await PharmacyOrder.find({ patientId: req.params.patientId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json(orders.map(o => publicOrder(o, "patient")));
  } catch (err) {
    return next(err);
  }
});

// GET /api/patient-app/:patientId/orders/:id
router.get("/:patientId/orders/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await PharmacyOrder.findOne({
      _id: req.params.id,
      patientId: req.params.patientId,
    }).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const result = publicOrder(order, "patient");

    if (order.status === "ready" || order.status === "out_for_delivery") {
      const otpDoc = await PharmacyOrderOtp.findOne({ orderId: String(order._id) }).lean();
      if (otpDoc?.otp) {
        result.handoverOtp = otpDoc.otp;
      } else {
        const testOtp = _getTestOtp(order._id);
        if (testOtp) result.handoverOtp = testOtp;
      }
    }

    if (order.status === "out_for_delivery") {
      const delivery = await Delivery.findOne({ orderId: String(order._id) }).lean();
      if (delivery?.lastLocation) {
        result.courierLocation = delivery.lastLocation;
        result.lastLocation = delivery.lastLocation;
      }
    }

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/patient-app/:patientId/orders/:id/cancel
router.post("/:patientId/orders/:id/cancel", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await PharmacyOrder.findOne({
      _id: req.params.id,
      patientId: req.params.patientId,
    }).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const { order: updated } = await applyAction(
      order._id,
      "cancel",
      { id: req.params.patientId, kind: "patient" },
      { reason: req.body?.reason || "Patient cancelled" }
    );

    return res.json(publicOrder(updated, "patient"));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
