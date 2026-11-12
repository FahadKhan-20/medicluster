const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const {
  signToken,
  signPatientToken,
  signStaffToken,
  requireAuth,
  requirePatientOrClinician,
  requirePharmacist,
  requireCourier,
} = require('../middleware/auth');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const { pharmacyAuth, courierAuth } = require('../routes/pharmacyAuthRoutes');

const JWT_SECRET = 'pharmacy-auth-test-secret-at-least-32-chars';

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

  const pharmacy = await Pharmacy.create({
    name: 'Test Pharmacy',
    address: '123 Health Ave',
    lat: 12.9716,
    lng: 77.5946,
    phone: '555-0100',
    active: true,
  });

  const pharmacistPasswordHash = await bcrypt.hash('pharm-pass-1234', 10);
  const pharmacist = await PharmacyStaff.create({
    name: 'Alice Pharmacist',
    role: 'pharmacist',
    email: 'alice@pharmacy.test',
    passwordHash: pharmacistPasswordHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });

  const inactivePharmacist = await PharmacyStaff.create({
    name: 'Inactive Bob',
    role: 'pharmacist',
    email: 'bob@pharmacy.test',
    passwordHash: pharmacistPasswordHash,
    pharmacyIds: [String(pharmacy._id)],
    active: false,
  });

  const courierPinHash = await bcrypt.hash('4321', 10);
  const courier = await PharmacyStaff.create({
    name: 'Charlie Courier',
    role: 'courier',
    phone: '+919999900001',
    passwordHash: courierPinHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/pharmacy-auth', pharmacyAuth);
  app.use('/api/courier-auth', courierAuth);

  // Dummy routes for testing auth guards
  app.get('/test/clinician-only', requireAuth, (req, res) => res.json({ ok: true, userId: req.userId }));
  app.get('/test/patient-or-clinician', requirePatientOrClinician, (req, res) => res.json({ ok: true, session: req.session }));
  app.get('/test/pharmacist-only', requirePharmacist, (req, res) => res.json({ ok: true, staff: req.staff }));
  app.get('/test/courier-only', requireCourier, (req, res) => res.json({ ok: true, staff: req.staff }));

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

  return {
    call,
    pharmacy,
    pharmacist,
    inactivePharmacist,
    courier,
  };
}

test('pharmacist logs in with email and password', async t => {
  const { call, pharmacy } = await setup(t);
  const res = await call('POST', '/api/pharmacy-auth/login', null, {
    email: 'alice@pharmacy.test',
    password: 'pharm-pass-1234',
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.staff.email, 'alice@pharmacy.test');
  assert.equal(res.body.staff.role, 'pharmacist');
  assert.equal(res.body.staff.passwordHash, undefined);
  assert.ok(Array.isArray(res.body.pharmacies));
  assert.equal(res.body.pharmacies.length, 1);
  assert.equal(res.body.pharmacies[0]._id, String(pharmacy._id));
});

test('courier logs in with phone and pin', async t => {
  const { call } = await setup(t);
  const res = await call('POST', '/api/courier-auth/login', null, {
    phone: '+919999900001',
    pin: '4321',
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.staff.phone, '+919999900001');
  assert.equal(res.body.staff.role, 'courier');
  assert.equal(res.body.staff.passwordHash, undefined);
});

test('wrong password and unknown email return the same 401', async t => {
  const { call } = await setup(t);
  const wrongPass = await call('POST', '/api/pharmacy-auth/login', null, {
    email: 'alice@pharmacy.test',
    password: 'wrong-password',
  });
  const unknownUser = await call('POST', '/api/pharmacy-auth/login', null, {
    email: 'nobody@pharmacy.test',
    password: 'wrong-password',
  });

  assert.equal(wrongPass.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(wrongPass.body, { error: 'Invalid credentials' });
  assert.deepEqual(unknownUser.body, { error: 'Invalid credentials' });
});

test('inactive staff cannot log in', async t => {
  const { call } = await setup(t);
  const res = await call('POST', '/api/pharmacy-auth/login', null, {
    email: 'bob@pharmacy.test',
    password: 'pharm-pass-1234',
  });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Invalid credentials' });
});

test('staff tokens are rejected by clinician and patient guards', async t => {
  const { call, pharmacist, courier } = await setup(t);
  const pharmacyToken = signStaffToken(pharmacist);
  const courierToken = signStaffToken(courier);

  for (const token of [pharmacyToken, courierToken]) {
    const clinicianRes = await call('GET', '/test/clinician-only', token);
    assert.equal(clinicianRes.status, 403);

    const patientClinicianRes = await call('GET', '/test/patient-or-clinician', token);
    assert.equal(patientClinicianRes.status, 403);
  }
});

test('patient and clinician tokens are rejected by requirePharmacist and requireCourier', async t => {
  const { call, pharmacist, courier } = await setup(t);
  const clinicianToken = signToken({ _id: 'clinician-1' });
  const patientToken = signPatientToken('patient-1');
  const pharmacyToken = signStaffToken(pharmacist);
  const courierToken = signStaffToken(courier);

  // Clinician token on pharmacist and courier
  assert.equal((await call('GET', '/test/pharmacist-only', clinicianToken)).status, 403);
  assert.equal((await call('GET', '/test/courier-only', clinicianToken)).status, 403);

  // Patient token on pharmacist and courier
  assert.equal((await call('GET', '/test/pharmacist-only', patientToken)).status, 403);
  assert.equal((await call('GET', '/test/courier-only', patientToken)).status, 403);

  // Courier token on pharmacist route
  assert.equal((await call('GET', '/test/pharmacist-only', courierToken)).status, 403);

  // Pharmacist token on courier route
  assert.equal((await call('GET', '/test/courier-only', pharmacyToken)).status, 403);

  // No token -> 401
  assert.equal((await call('GET', '/test/pharmacist-only', null)).status, 401);
  assert.equal((await call('GET', '/test/courier-only', null)).status, 401);
});
