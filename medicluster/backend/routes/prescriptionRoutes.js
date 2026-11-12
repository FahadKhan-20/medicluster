/**
 * backend/routes/prescriptionRoutes.js
 * Clinician routes for prescriptions and pharmacy listings.
 */

const express = require("express");
const Prescription = require("../models/Prescription");
const Pharmacy = require("../models/Pharmacy");
const { isValidId } = require("../db/ids");

const prescriptions = express.Router();

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    return "Items must be an array of 1 to 20 medications";
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") {
      return `Item at index ${i} must be an object`;
    }
    if (!it.drug || typeof it.drug !== "string" || !it.drug.trim()) {
      return `Item at index ${i} is missing a valid drug name`;
    }
    if (typeof it.quantity !== "number" || !Number.isInteger(it.quantity) || it.quantity < 1) {
      return `Item at index ${i} must have an integer quantity of at least 1`;
    }
  }
  return null;
}

// POST /api/prescriptions
prescriptions.post("/", async (req, res, next) => {
  try {
    const { patientId, items, notes, pharmacyId } = req.body || {};
    if (!patientId || typeof patientId !== "string" || !patientId.trim()) {
      return res.status(400).json({ error: "patientId is required" });
    }

    const itemError = validateItems(items);
    if (itemError) {
      return res.status(400).json({ error: itemError });
    }

    const prescription = await Prescription.create({
      patientId: patientId.trim(),
      doctorUserId: req.userId,
      items: items.map(it => ({
        drug: it.drug.trim(),
        strength: it.strength?.trim() ?? "",
        form: it.form?.trim() ?? "",
        dose: it.dose?.trim() ?? "",
        frequency: it.frequency?.trim() ?? "",
        durationDays: Number.isFinite(it.durationDays) ? it.durationDays : null,
        quantity: it.quantity,
        instructions: it.instructions?.trim() ?? "",
      })),
      notes: notes?.trim() ?? "",
      status: "active",
      pharmacyId: pharmacyId ? String(pharmacyId).trim() : null,
    });

    return res.status(201).json(prescription);
  } catch (err) {
    return next(err);
  }
});

// GET /api/prescriptions?patientId=
prescriptions.get("/", async (req, res, next) => {
  try {
    const { patientId } = req.query;
    const filter = {};
    if (patientId) {
      filter.patientId = String(patientId).trim();
    }
    const list = await Prescription.find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return res.json(list);
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/prescriptions/:id
prescriptions.patch("/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid prescription id" });
    }
    const { status } = req.body || {};
    if (status !== "cancelled") {
      return res.status(400).json({ error: "Status can only be updated to cancelled" });
    }

    const updated = await Prescription.findByIdAndUpdate(
      req.params.id,
      { status: "cancelled" },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ error: "Prescription not found" });
    }
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

const pharmacies = express.Router();

// GET /api/pharmacies
pharmacies.get("/", async (_req, res, next) => {
  try {
    const list = await Pharmacy.find({ active: true })
      .sort({ name: 1 })
      .lean();
    return res.json(list);
  } catch (err) {
    return next(err);
  }
});

module.exports = { prescriptions, pharmacies };
