/**
 * backend/routes/ecgRoutes.js
 * Upload and retrieval endpoints for 12-lead ECG records (clinicians/emergency crew).
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const EcgRecord = require('../models/EcgRecord');

const router = express.Router();
router.use(requireAuth);

/**
 * Validate that signal is a 12x1000 array of numbers.
 */
function validateSignal(signal) {
  if (!Array.isArray(signal) || signal.length !== 12) {
    return 'signal must be an array of 12 leads';
  }
  for (let i = 0; i < 12; i++) {
    if (!Array.isArray(signal[i]) || signal[i].length !== 1000) {
      return `lead ${i} must contain exactly 1000 samples`;
    }
    for (let j = 0; j < 1000; j++) {
      const val = signal[i][j];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        return `lead ${i} sample ${j} must be a finite number`;
      }
    }
  }
  return null;
}

/**
 * POST /upload or /
 * Upload a 12-lead ECG record for a patient.
 */
const handleUpload = async (req, res, next) => {
  try {
    const { patient_id, signal, lead_order, device, recordedAt } = req.body || {};
    if (!patient_id || typeof patient_id !== 'string' || !patient_id.trim()) {
      return res.status(400).json({ error: 'patient_id is required' });
    }

    const signalError = validateSignal(signal);
    if (signalError) {
      return res.status(400).json({ error: signalError });
    }

    const recordData = {
      patient_id: patient_id.trim(),
      signal,
      lead_order: Array.isArray(lead_order) && lead_order.length === 12 ? lead_order : undefined,
      device: typeof device === 'string' && device.trim() ? device.trim() : '12-lead ECG',
      recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
      status: 'uploaded',
      uploadedBy: req.userId || 'system',
    };

    const record = new EcgRecord(recordData);
    await record.save();

    res.status(201).json({ record: record.toObject() });
  } catch (err) {
    next(err);
  }
};

router.post('/upload', handleUpload);
router.post('/', handleUpload);

/**
 * GET /:id
 * Retrieve a single ECG record.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const record = await EcgRecord.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'ECG record not found' });
    }
    res.json({ record: record.toObject() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /
 * List ECG records, optionally filtered by patient_id.
 */
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.patient_id) {
      filter.patient_id = String(req.query.patient_id);
    }
    const records = await EcgRecord.find(filter);
    res.json({ records: records.map(r => r.toObject()) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
