const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const {
  signToken,
  signPatientToken,
  signStaffToken,
  requireAuth,
} = require('../middleware/auth');
const Pharmacy = require('../models/Pharmacy');
const { prescriptions, pharmacies } = require('../routes/prescriptionRoutes');

const JWT_SECRET = 'prescription-test-secret-at-least-32-chars-long';

async function setup(t) {
  await createTestDatabase(t);
  const previous = Object.fromEntries(
    ['JWT_SECRET', 'ALLOWED_STAFF_EMAILS', 'ALLOWED_EMAIL_DOMAINS'].map(k => [k, process.env[k]])
  );
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/prescriptions', requireAuth, prescriptions);
  app.use('/api/pharmacies', requireAuth, pharmacies);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const res = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const doctor = signToken({ _id: 'doc-123' });
  const patient = signPatientToken('pat-1');
  const pharmacist = signStaffToken({ _id: 'pharm-1', role: 'pharmacist' });

  return { call, doctor, patient, pharmacist };
}

test('clinician creates, lists, and cancels a prescription', async t => {
  const { call, doctor } = await setup(t);

  // 1. Create prescription
  const payload = {
    patientId: 'pat-1',
    items: [
      {
        drug: 'Amoxicillin',
        strength: '500mg',
        form: 'capsule',
        dose: '1 cap',
        frequency: 'TID',
        durationDays: 7,
        quantity: 21,
        instructions: 'Take after food',
      },
    ],
    notes: 'Mild penicillin tolerance',
    pharmacyId: 'pharma-99',
  };

  const createRes = await call('POST', '/api/prescriptions', doctor, payload);
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.patientId, 'pat-1');
  assert.equal(createRes.body.doctorUserId, 'doc-123');
  assert.equal(createRes.body.status, 'active');
  assert.equal(createRes.body.items.length, 1);
  assert.equal(createRes.body.items[0].drug, 'Amoxicillin');
  assert.equal(createRes.body.items[0].quantity, 21);
  const rxId = createRes.body._id;
  assert.ok(rxId);

  // 2. List prescriptions for patient
  const listRes = await call('GET', '/api/prescriptions?patientId=pat-1', doctor);
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0]._id, rxId);

  // 3. Cancel prescription
  const cancelRes = await call('PATCH', `/api/prescriptions/${rxId}`, doctor, { status: 'cancelled' });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'cancelled');

  // Verify list reflects cancelled
  const listAfterCancel = await call('GET', '/api/prescriptions?patientId=pat-1', doctor);
  assert.equal(listAfterCancel.body[0].status, 'cancelled');
});

test('PATCH prescription with status other than cancelled returns 400', async t => {
  const { call, doctor } = await setup(t);
  const createRes = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: [{ drug: 'Aspirin', quantity: 10 }],
  });
  assert.equal(createRes.status, 201);

  const res = await call('PATCH', `/api/prescriptions/${createRes.body._id}`, doctor, { status: 'fulfilled' });
  assert.equal(res.status, 400);
});

test('prescription validation returns 400 on empty items, missing drug, or quantity 0', async t => {
  const { call, doctor } = await setup(t);

  // Empty items
  const res1 = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: [],
  });
  assert.equal(res1.status, 400);

  // Missing drug
  const res2 = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: [{ quantity: 5 }],
  });
  assert.equal(res2.status, 400);

  // Quantity 0
  const res3 = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: [{ drug: 'Paracetamol', quantity: 0 }],
  });
  assert.equal(res3.status, 400);

  // Quantity negative or non-integer
  const res4 = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: [{ drug: 'Paracetamol', quantity: 2.5 }],
  });
  assert.equal(res4.status, 400);

  // Items length > 20
  const tooManyItems = Array.from({ length: 21 }, (_, i) => ({ drug: `Drug-${i}`, quantity: 1 }));
  const res5 = await call('POST', '/api/prescriptions', doctor, {
    patientId: 'pat-1',
    items: tooManyItems,
  });
  assert.equal(res5.status, 400);
});

test('prescription routes reject unauthenticated and unauthorized tokens', async t => {
  const { call, patient, pharmacist } = await setup(t);

  // 401 without token
  assert.equal((await call('GET', '/api/prescriptions?patientId=pat-1', null)).status, 401);
  assert.equal((await call('POST', '/api/prescriptions', null, {})).status, 401);

  // 403 with patient token
  assert.equal((await call('GET', '/api/prescriptions?patientId=pat-1', patient)).status, 403);
  assert.equal((await call('POST', '/api/prescriptions', patient, {})).status, 403);

  // 403 with pharmacy token
  assert.equal((await call('GET', '/api/prescriptions?patientId=pat-1', pharmacist)).status, 403);
  assert.equal((await call('POST', '/api/prescriptions', pharmacist, {})).status, 403);
});

test('pharmacies list hides active: false', async t => {
  const { call, doctor } = await setup(t);

  await Pharmacy.create({
    name: 'Active Pharmacy',
    address: '100 Active St',
    active: true,
  });
  await Pharmacy.create({
    name: 'Inactive Pharmacy',
    address: '200 Inactive St',
    active: false,
  });

  const res = await call('GET', '/api/pharmacies', doctor);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const names = res.body.map(p => p.name);
  assert.ok(names.includes('Active Pharmacy'));
  assert.ok(!names.includes('Inactive Pharmacy'));
});
