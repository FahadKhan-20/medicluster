/**
 * backend/routes/pharmacyRoutes.js
 * Pharmacist order management, courier dispatch, and inventory control.
 */

const express = require("express");
const PharmacyOrder = require("../models/PharmacyOrder");
const PharmacyStock = require("../models/PharmacyStock");
const PharmacyStaff = require("../models/PharmacyStaff");
const { applyAction, publicOrder } = require("../services/pharmacyOrderStore");
const { isValidId } = require("../db/ids");

const router = express.Router();

function checkPharmacyAccess(req, pharmacyId) {
  if (!pharmacyId) return false;
  const staffPharms = (req.staff?.pharmacyIds || []).map(String);
  return staffPharms.includes(String(pharmacyId));
}

// GET /api/pharmacy/orders?pharmacyId=&status=
router.get("/orders", async (req, res, next) => {
  try {
    const { pharmacyId, status } = req.query;
    if (!pharmacyId || !checkPharmacyAccess(req, pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    const filter = { pharmacyId: String(pharmacyId) };
    if (status) {
      filter.status = String(status);
    }

    const orders = await PharmacyOrder.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.json(orders.map(o => publicOrder(o, "pharmacy")));
  } catch (err) {
    return next(err);
  }
});

// GET /api/pharmacy/orders/:id
router.get("/orders/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const order = await PharmacyOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!checkPharmacyAccess(req, order.pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    return res.json(publicOrder(order, "pharmacy"));
  } catch (err) {
    return next(err);
  }
});

// POST /api/pharmacy/orders/:id/actions
router.post("/orders/:id/actions", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const order = await PharmacyOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!checkPharmacyAccess(req, order.pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    const { action, reason, otp, courierId } = req.body || {};
    const actor = {
      kind: "pharmacy",
      id: req.staff.id,
      pharmacyIds: req.staff.pharmacyIds,
    };

    const result = await applyAction(req.params.id, action, actor, { reason, otp, courierId });

    return res.json({
      order: publicOrder(result.order, "pharmacy"),
      ...(result.stockWarnings ? { stockWarnings: result.stockWarnings } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/pharmacy/couriers?pharmacyId=
router.get("/couriers", async (req, res, next) => {
  try {
    const { pharmacyId } = req.query;
    if (!pharmacyId || !checkPharmacyAccess(req, pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    const couriers = await PharmacyStaff.find({
      role: "courier",
      active: true,
      pharmacyIds: String(pharmacyId),
    }).lean();

    const sanitized = couriers.map(c => {
      const copy = { ...c };
      delete copy.passwordHash;
      return copy;
    });

    return res.json(sanitized);
  } catch (err) {
    return next(err);
  }
});

// GET /api/pharmacy/stock?pharmacyId=&q=&barcode=
router.get("/stock", async (req, res, next) => {
  try {
    const { pharmacyId, q, barcode } = req.query;
    if (!pharmacyId || !checkPharmacyAccess(req, pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    let stocks = await PharmacyStock.find({ pharmacyId: String(pharmacyId) })
      .sort({ drug: 1 })
      .lean();

    if (barcode) {
      stocks = stocks.filter(s => s.barcode === String(barcode).trim());
    }
    if (q) {
      const queryLower = String(q).trim().toLowerCase();
      stocks = stocks.filter(s => (s.drug || "").toLowerCase().includes(queryLower));
    }

    return res.json(stocks);
  } catch (err) {
    return next(err);
  }
});

// POST /api/pharmacy/stock
router.post("/stock", async (req, res, next) => {
  try {
    const { pharmacyId, drug, strength, barcode, quantity, batch, expiry, lowStockThreshold } = req.body || {};
    if (!pharmacyId || !checkPharmacyAccess(req, pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    if (!drug || typeof drug !== "string" || !drug.trim()) {
      return res.status(400).json({ error: "Drug name is required" });
    }

    const created = await PharmacyStock.create({
      pharmacyId: String(pharmacyId),
      drug: drug.trim(),
      strength: strength?.trim() ?? "",
      barcode: barcode?.trim() ?? "",
      quantity: Number.isFinite(quantity) ? quantity : 0,
      batch: batch?.trim() ?? "",
      expiry: expiry?.trim() ?? "",
      lowStockThreshold: Number.isFinite(lowStockThreshold) ? lowStockThreshold : 10,
    });

    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/pharmacy/stock/:id
router.patch("/stock/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: "Invalid stock id" });
    }

    const stock = await PharmacyStock.findById(req.params.id).lean();
    if (!stock) {
      return res.status(404).json({ error: "Stock item not found" });
    }

    if (!checkPharmacyAccess(req, stock.pharmacyId)) {
      return res.status(403).json({ error: "Access to this pharmacy is forbidden" });
    }

    const allowed = ["quantity", "batch", "expiry", "lowStockThreshold"];
    const update = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        update[key] = req.body[key];
      }
    }

    const updated = await PharmacyStock.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
