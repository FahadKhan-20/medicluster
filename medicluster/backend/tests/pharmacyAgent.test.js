const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const {
  signAgentToken,
  signToken,
  signPatientToken,
  signStaffToken,
  requireAuth,
} = require('../middleware/auth');
const User = require('../models/User');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const PharmacyStock = require('../models/PharmacyStock');
const PharmacyOrder = require('../models/PharmacyOrder');
const Prescription = require('../models/Prescription');
const RefillSuggestion = require('../models/RefillSuggestion');
const pharmacyAgentRoutes = require('../routes/pharmacyAgentRoutes');

const JWT_SECRET = 'pharmacy-agent-test-jwt-secret-at-least-32-chars';
const AGENT_JWT_SECRET = 'pharmacy-agent-key-secret-at-least-32-chars-long';

async function setup(t) {
  await createTestDatabase(t);
  const previous = Object.fromEntries(
    ['JWT_SECRET', 'AGENT_JWT_SECRET', 'ALLOWED_STAFF_EMAILS', 'ALLOWED_EMAIL_DOMAINS'].map(k => [k, process.env[k]])
  );
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_JWT_SECRET = AGENT_JWT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/pharmacy/agent', requireAuth, pharmacyAgentRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}/api/pharmacy/agent`;

  async function api(path, method = 'GET', body, token) {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  const agentToken = signAgentToken();

  const doc = await User.create({
    email: 'clinician@test.org',
    name: 'Clinician User',
    passwordHash: 'dummy',
    role: 'doctor',
  });
  const clinicianToken = signToken(doc);
  const patientToken = signPatientToken('pat_agent_test');

  const pharmacy = await Pharmacy.create({
    name: 'Agent Test Pharmacy',
    address: '100 Agent Way',
    lat: 12.97,
    lng: 77.59,
    phone: '555-0199',
    active: true,
  });

  const staff = await PharmacyStaff.create({
    name: 'Pharma Staff',
    role: 'pharmacist',
    email: 'staff@test.org',
    passwordHash: 'dummy',
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });
  const staffToken = signStaffToken(staff);

  return {
    api,
    agentToken,
    clinicianToken,
    patientToken,
    staffToken,
    pharmacy,
  };
}

test('agent stock-low returns low stock items to agent, 403/401 to others', async (t) => {
  const { api, agentToken, clinicianToken, patientToken, staffToken, pharmacy } = await setup(t);

  // Seed stock: 1 low, 1 high
  await PharmacyStock.create({
    pharmacyId: String(pharmacy._id),
    drug: 'LowStockDrug',
    quantity: 4,
    reorderThreshold: 15,
  });
  await PharmacyStock.create({
    pharmacyId: String(pharmacy._id),
    drug: 'HighStockDrug',
    quantity: 100,
    reorderThreshold: 10,
  });

  // Agent call succeeds
  const res = await api('/stock-low', 'GET', undefined, agentToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].drug, 'LowStockDrug');

  // Clinician, patient, staff, unauthenticated get 403/401
  assert.equal((await api('/stock-low', 'GET', undefined, clinicianToken)).status, 403);
  assert.equal((await api('/stock-low', 'GET', undefined, patientToken)).status, 403);
  assert.equal((await api('/stock-low', 'GET', undefined, staffToken)).status, 403);
  assert.equal((await api('/stock-low', 'GET', undefined, null)).status, 401);
});

test('agent stuck-orders returns orders exceeding time threshold to agent, 403/401 to others', async (t) => {
  const { api, agentToken, clinicianToken, patientToken, staffToken, pharmacy } = await setup(t);

  // Seed stuck order: ready 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
  const stuckOrder = await PharmacyOrder.create({
    patientId: 'pat_stuck',
    pharmacyId: String(pharmacy._id),
    source: { type: 'refill' },
    items: [{ drug: 'StuckDrug', quantity: 1 }],
    fulfilment: 'pickup',
    status: 'ready',
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
  });

  // Recent order
  await PharmacyOrder.create({
    patientId: 'pat_recent',
    pharmacyId: String(pharmacy._id),
    source: { type: 'refill' },
    items: [{ drug: 'RecentDrug', quantity: 1 }],
    fulfilment: 'pickup',
    status: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Agent call
  const res = await api('/stuck-orders?thresholdMinutes=60', 'GET', undefined, agentToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0]._id, String(stuckOrder._id));

  // Non-agents blocked
  assert.equal((await api('/stuck-orders', 'GET', undefined, clinicianToken)).status, 403);
  assert.equal((await api('/stuck-orders', 'GET', undefined, patientToken)).status, 403);
  assert.equal((await api('/stuck-orders', 'GET', undefined, staffToken)).status, 403);
  assert.equal((await api('/stuck-orders', 'GET', undefined, null)).status, 401);
});

test('agent refill-suggestion creates suggestion for clinician review, NEVER an order or prescription', async (t) => {
  const { api, agentToken, clinicianToken, patientToken, staffToken } = await setup(t);

  const initialOrders = await PharmacyOrder.countDocuments({});
  const initialRx = await Prescription.countDocuments({});

  const res = await api('/refill-suggestion', 'POST', {
    patientId: 'pat_refill_ai',
    drug: 'Metformin',
    dose: '500mg',
    reason: 'Adherence monitoring indicates supply depletion in 4 days',
    confidence: 0.95,
  }, agentToken);

  assert.equal(res.status, 201);
  assert.equal(res.body.patientId, 'pat_refill_ai');
  assert.equal(res.body.drug, 'Metformin');
  assert.equal(res.body.status, 'pending_clinician_approval');

  // Verify stored in RefillSuggestion
  const stored = await RefillSuggestion.findById(res.body._id).lean();
  assert.ok(stored);
  assert.equal(stored.drug, 'Metformin');
  assert.equal(stored.status, 'pending_clinician_approval');

  // CRITICAL CHECK: Ensure NO PharmacyOrder and NO Prescription was created!
  const finalOrders = await PharmacyOrder.countDocuments({});
  const finalRx = await Prescription.countDocuments({});
  assert.equal(finalOrders, initialOrders, 'Must NEVER create a PharmacyOrder');
  assert.equal(finalRx, initialRx, 'Must NEVER create a Prescription');

  // Non-agents blocked
  assert.equal((await api('/refill-suggestion', 'POST', { patientId: 'p', drug: 'd' }, clinicianToken)).status, 403);
  assert.equal((await api('/refill-suggestion', 'POST', { patientId: 'p', drug: 'd' }, patientToken)).status, 403);
  assert.equal((await api('/refill-suggestion', 'POST', { patientId: 'p', drug: 'd' }, staffToken)).status, 403);
  assert.equal((await api('/refill-suggestion', 'POST', { patientId: 'p', drug: 'd' }, null)).status, 401);
});
