/**
 * backend/routes/pharmacyAgentRoutes.js
 * Autonomous agent routes for low stock monitoring, stuck orders, and refill suggestions.
 * Strictly limited to agent identity token.
 */

const express = require("express");
const PharmacyStock = require("../models/PharmacyStock");
const PharmacyOrder = require("../models/PharmacyOrder");
const RefillSuggestion = require("../models/RefillSuggestion");

const router = express.Router();

router.use((req, res, next) => {
  if (!req.agent) {
    return res.status(403).json({ error: "Agent access only" });
  }
  next();
});

// GET /api/pharmacy/agent/stock-low
router.get("/stock-low", async (req, res, next) => {
  try {
    const { pharmacyId, threshold } = req.query;
    const filter = {};
    if (pharmacyId) filter.pharmacyId = String(pharmacyId);

    const stocks = await PharmacyStock.find(filter).lean();
    const defaultThreshold = threshold ? Number(threshold) : 10;

    const lowStock = stocks.filter(s => {
      const limit = (typeof s.reorderThreshold === "number" && s.reorderThreshold > 0)
        ? s.reorderThreshold
        : defaultThreshold;
      return s.quantity <= limit;
    });

    return res.json(lowStock);
  } catch (err) {
    return next(err);
  }
});

// GET /api/pharmacy/agent/stuck-orders
router.get("/stuck-orders", async (req, res, next) => {
  try {
    const { thresholdMinutes = 60, pharmacyId } = req.query;
    const minutes = Number(thresholdMinutes) || 60;
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);

    const filter = {};
    if (pharmacyId) filter.pharmacyId = String(pharmacyId);

    const orders = await PharmacyOrder.find(filter).lean();
    const stuck = orders.filter(o => {
      if (!["ready", "out_for_delivery", "preparing"].includes(o.status)) return false;
      const lastUpdate = o.updatedAt ? new Date(o.updatedAt) : new Date(o.createdAt);
      return lastUpdate <= cutoff;
    });

    return res.json(stuck);
  } catch (err) {
    return next(err);
  }
});

// POST /api/pharmacy/agent/refill-suggestion
router.post("/refill-suggestion", async (req, res, next) => {
  try {
    const { patientId, drug, dose, reason, confidence } = req.body || {};
    if (!patientId || typeof patientId !== "string" || !patientId.trim()) {
      return res.status(400).json({ error: "patientId is required" });
    }
    if (!drug || typeof drug !== "string" || !drug.trim()) {
      return res.status(400).json({ error: "drug is required" });
    }

    const suggestion = await RefillSuggestion.create({
      patientId: patientId.trim(),
      drug: drug.trim(),
      dose: dose ? String(dose).trim() : "",
      reason: reason ? String(reason).trim() : "",
      confidence: typeof confidence === "number" ? confidence : null,
      status: "pending_clinician_approval",
    });

    return res.status(201).json(suggestion.toObject ? suggestion.toObject() : suggestion);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
