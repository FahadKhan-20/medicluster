/**
 * backend/routes/reminderRoutes.js
 * CRUD for patient medication reminders.
 */

const express = require("express");
const { isValidId } = require("../db/ids");
const Reminder = require("../models/Reminder");
const ReminderNotification = require("../models/ReminderNotification");

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

// Loads :id and checks access; responds and returns null when it can't continue.
async function loadOwned(req, res) {
  if (!isValidId(req.params.id)) { res.status(400).json({ error: "Invalid reminder id" }); return null; }
  const r = await Reminder.findById(req.params.id, { patientId: 1 }).lean();
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
  try { if (!(await loadOwned(req, res))) return; } catch (err) { return next(err); }
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: "Invalid reminder id" });
  }
  try {
    const allowed = ["medicationName", "dosage", "times", "frequency", "days", "notes", "active", "pillsLeft", "refillRequestedAt"];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const updated = await Reminder.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: "Reminder not found" });
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/reminders/:id/doses ─────────────────────────────────────────
// Mark one dose slot as taken. Idempotent per (date, time); decrements pillsLeft once.
router.post("/:id/doses", async (req, res, next) => {
  try { if (!(await loadOwned(req, res))) return; } catch (err) { return next(err); }
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: "Invalid reminder id" });
  }
  const { date, time } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{2}:\d{2}$/.test(time ?? "")) {
    return res.status(400).json({ error: "date (YYYY-MM-DD) and time (HH:MM) are required" });
  }
  try {
    const updated = await Reminder.findOneAndUpdate(
      { _id: req.params.id, doseLog: { $not: { $elemMatch: { date, time } } } },
      { $push: { doseLog: { date, time, takenAt: new Date() } } },
      { new: true }
    );
    if (!updated) {
      const existing = await Reminder.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ error: "Reminder not found" });
      return res.json(existing); // already logged
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
