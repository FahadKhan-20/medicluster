/**
 * backend/routes/reminderRoutes.js
 * CRUD for patient medication reminders.
 */

const express = require("express");
const { isValidId } = require("../db/ids");
const Reminder = require("../models/Reminder");
const ReminderNotification = require("../models/ReminderNotification");
const Pharmacy = require("../models/Pharmacy");
const PharmacyOrder = require("../models/PharmacyOrder");

const { requireAuth, requirePatientOrClinician, canAccessPatient } = require("../middleware/auth");

const router = express.Router();

// ── POST /api/reminders/:id/notify (or /notify) ── agent-core only ──────────
const MAX_NOTIFY_MESSAGE = 2000;
const MAX_ID = 128;
const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

async function handleReminderNotify(req, res, next) {
  try {
    if (!req.agent) return res.status(403).json({ error: "Agent sign-in required" });
    const reminderId = req.params.id || req.body?.reminder_id || req.body?.reminderId;
    const { patient_id, patientId, date, time, message, audit_id, auditId, status } = req.body || {};
    const effectivePatientId = patient_id || patientId;
    const effectiveAuditId = audit_id || auditId || "";
    const effectiveStatus = status || "sent";

    if (!isText(reminderId, MAX_ID)) {
      return res.status(400).json({ error: "reminderId is required" });
    }
    if (!isText(effectivePatientId, MAX_ID)) {
      return res.status(400).json({ error: "patientId is required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
    }
    if (!/^\d{2}:\d{2}$/.test(time ?? "")) {
      return res.status(400).json({ error: "time (HH:MM) is required" });
    }
    if (!isText(message, MAX_NOTIFY_MESSAGE)) {
      return res.status(400).json({ error: `message is required (max ${MAX_NOTIFY_MESSAGE} chars)` });
    }

    const reminder = await Reminder.findById(reminderId).lean();
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    const existing = await ReminderNotification.findOne({ reminderId, date, time }).lean();
    if (existing) {
      const updated = await ReminderNotification.findByIdAndUpdate(
        existing._id,
        {
          message,
          auditId: effectiveAuditId,
          status: effectiveStatus,
          sentAt: new Date(),
        },
        { new: true }
      ).lean();
      return res.status(200).json(updated);
    }

    const created = await ReminderNotification.create({
      reminderId,
      patientId: effectivePatientId,
      date,
      time,
      message,
      auditId: effectiveAuditId,
      status: effectiveStatus,
      sentAt: new Date(),
    });
    return res.status(201).json(created.toObject ? created.toObject() : created);
  } catch (err) {
    return next(err);
  }
}

router.post("/notify", requireAuth, handleReminderNotify);
router.post("/:id/notify", requireAuth, handleReminderNotify);

// Clinicians may manage any patient's reminders; a signed-in patient only their own.
router.use(requirePatientOrClinician);
const forbidden = (res) => res.status(403).json({ error: "Not your record" });
const WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const validTime=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function scheduleError(value){
  if(!Array.isArray(value.times)||!value.times.length||value.times.some(t=>!validTime(t)))return 'Provide valid HH:MM reminder times';
  if(!['daily','weekly','as-needed'].includes(value.frequency))return 'Choose a valid reminder frequency';
  if(!Array.isArray(value.days)||value.days.some(d=>!WEEKDAYS.includes(d)))return 'Choose valid weekdays';
  if(value.frequency==='weekly'&&!value.days.length)return 'Choose weekdays for a weekly reminder';
  return null;
}

// Loads :id and checks access; responds and returns null when it can't continue.
async function loadOwned(req, res) {
  if (!isValidId(req.params.id)) { res.status(400).json({ error: "Invalid reminder id" }); return null; }
  const r = await Reminder.findById(req.params.id).lean();
  if (!r) { res.status(404).json({ error: "Reminder not found" }); return null; }
  if (!canAccessPatient(req, r.patientId)) { forbidden(res); return null; }
  return r;
}

// ── GET /api/reminders/:patientId ─────────────────────────────────────────
router.get("/:patientId", async (req, res, next) => {
  if (!canAccessPatient(req, req.params.patientId)) return forbidden(res);
  try {
    const reminders = await Reminder.find({ patientId: req.params.patientId })
      .sort({ active: -1, createdAt: -1 })
      .lean();
    return res.json(reminders);
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/reminders ───────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  const { patientId, medicationName, dosage, times, frequency, days, notes, pillsLeft } = req.body;
  if (!patientId || !patientId.trim()) {
    return res.status(400).json({ error: "patientId is required" });
  }
  if (!canAccessPatient(req, patientId.trim())) return forbidden(res);
  if (!medicationName || !medicationName.trim()) {
    return res.status(400).json({ error: "medicationName is required" });
  }
  if (!Array.isArray(times) || times.length === 0) {
    return res.status(400).json({ error: "At least one reminder time is required" });
  }
  const invalid=scheduleError({times,frequency:frequency??'daily',days:days??[]});
  if(invalid)return res.status(400).json({error:invalid});
  try {
    const reminder = await Reminder.create({
      patientId: patientId.trim(),
      medicationName: medicationName.trim(),
      dosage: dosage?.trim() ?? "",
      times,
      frequency: frequency ?? "daily",
      days: days ?? [],
      notes: notes?.trim() ?? "",
      pillsLeft: Number.isFinite(pillsLeft) ? pillsLeft : null,
    });
    return res.status(201).json(reminder);
  } catch (err) {
    return next(err);
  }
});

// ── PATCH /api/reminders/:id ──────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  let current;
  try { current=await loadOwned(req, res);if(!current)return; } catch (err) { return next(err); }
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: "Invalid reminder id" });
  }
  try {
    const { refillPharmacyId, fulfilment = "pickup", deliveryAddress } = req.body;
    let refillOrderId;
    if (refillPharmacyId) {
      const pharmacy = await Pharmacy.findById(refillPharmacyId).lean();
      if (!pharmacy || !pharmacy.active) {
        return res.status(400).json({ error: "Invalid or inactive pharmacy" });
      }
      if (fulfilment === "delivery") {
        if (!deliveryAddress || typeof deliveryAddress.text !== "string" || !deliveryAddress.text.trim()) {
          return res.status(400).json({ error: "deliveryAddress is required for delivery fulfilment" });
        }
      }
      const order = await PharmacyOrder.create({
        patientId: current.patientId,
        pharmacyId: String(pharmacy._id),
        source: {
          type: "refill",
          reminderId: String(current._id),
        },
        items: [
          { drug: current.medicationName, dose: current.dosage || "", quantity: 1 }
        ],
        fulfilment,
        deliveryAddress: fulfilment === "delivery" ? deliveryAddress : null,
        status: "new",
        statusHistory: [{
          status: "new",
          at: new Date(),
          byKind: req.session?.kind || "patient",
          byId: String(req.session?.sub || current.patientId),
        }],
      });
      refillOrderId = String(order._id);
    }

    const allowed = ["medicationName", "dosage", "times", "frequency", "days", "notes", "active", "pillsLeft", "refillRequestedAt"];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (refillOrderId && !update.refillRequestedAt) {
      update.refillRequestedAt = new Date();
    }
    const invalid=['times','frequency','days'].some(key=>Object.hasOwn(update,key))?scheduleError({...current,...update}):null;
    if(invalid)return res.status(400).json({error:invalid});
    const updated = await Reminder.findOneAndUpdate({_id:req.params.id,patientId:current.patientId,updatedAt:current.updatedAt}, {$set:update}, { new: true }).lean();
    if (!updated) return res.status(409).json({ error: "Reminder changed; refresh and try again" });
    return res.json({ ...updated, ...(refillOrderId ? { refillOrderId } : {}) });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/reminders/:id/doses ─────────────────────────────────────────
// Mark one dose slot as taken. Idempotent per (date, time); decrements pillsLeft once.
router.post("/:id/doses", async (req, res, next) => {
  let current;
  try { current=await loadOwned(req, res);if(!current)return; } catch (err) { return next(err); }
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: "Invalid reminder id" });
  }
  const { date, time } = req.body;
  if (!validDate(date) || !validTime(time)) {
    return res.status(400).json({ error: "date (YYYY-MM-DD) and time (HH:MM) are required" });
  }
  if(current.doseLog.some(d=>d.date===date&&d.time===time))return res.json(current);
  if(!current.times.includes(time)||current.frequency==='weekly'&&!current.days.includes(WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]))return res.status(400).json({error:'Choose a scheduled dose slot'});
  try {
    const updated = await Reminder.findOneAndUpdate(
      { _id: req.params.id, patientId:current.patientId, updatedAt:current.updatedAt, doseLog: { $not: { $elemMatch: { date, time } } } },
      { $push: { doseLog: { date, time, takenAt: new Date() } } },
      { new: true }
    );
    if (!updated) {
      const existing = await Reminder.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ error: "Reminder not found" });
      if(existing.doseLog.some(d=>d.date===date&&d.time===time))return res.json(existing);
      return res.status(409).json({error:'Reminder changed; refresh and try again'});
    }
    if (typeof updated.pillsLeft === "number" && updated.pillsLeft > 0) {
      updated.pillsLeft -= 1;
      await updated.save();
    }
    return res.json(updated.toObject());
  } catch (err) {
    return next(err);
  }
});

// ── DELETE /api/reminders/:id ─────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try { if (!(await loadOwned(req, res))) return; } catch (err) { return next(err); }
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: "Invalid reminder id" });
  }
  try {
    const deleted = await Reminder.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: "Reminder not found" });
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
