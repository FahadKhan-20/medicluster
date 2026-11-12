/**
 * backend/routes/pharmacyAuthRoutes.js
 * Authentication endpoints for pharmacists (email/password) and couriers (phone/pin).
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const PharmacyStaff = require("../models/PharmacyStaff");
const Pharmacy = require("../models/Pharmacy");
const { signStaffToken } = require("../middleware/auth");

const DUMMY_HASH = "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012";

const pharmacyAuth = express.Router();

pharmacyAuth.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const staff = await PharmacyStaff.findOne({
      email: String(email).toLowerCase().trim(),
      role: "pharmacist",
    }).select("+passwordHash");

    const hash = staff ? staff.passwordHash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);

    if (!staff || !ok || !staff.active) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signStaffToken(staff);
    const staffObj = staff.toObject ? staff.toObject() : { ...staff };
    delete staffObj.passwordHash;

    const pharmacies = await Pharmacy.find({
      _id: { $in: staff.pharmacyIds || [] },
    }).lean();

    return res.json({ token, staff: staffObj, pharmacies });
  } catch (err) {
    return next(err);
  }
});

const courierAuth = express.Router();

courierAuth.post("/login", async (req, res, next) => {
  try {
    const { phone, pin } = req.body || {};
    if (!phone || (typeof pin !== "string" && typeof pin !== "number")) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const pinStr = String(pin).trim();
    const staff = await PharmacyStaff.findOne({
      phone: String(phone).trim(),
      role: "courier",
    }).select("+passwordHash");

    const hash = staff ? staff.passwordHash : DUMMY_HASH;
    const ok = await bcrypt.compare(pinStr, hash);

    if (!staff || !ok || !staff.active) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signStaffToken(staff);
    const staffObj = staff.toObject ? staff.toObject() : { ...staff };
    delete staffObj.passwordHash;

    return res.json({ token, staff: staffObj });
  } catch (err) {
    return next(err);
  }
});

module.exports = { pharmacyAuth, courierAuth };
