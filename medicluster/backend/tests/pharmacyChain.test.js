const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signToken, signPatientToken, signStaffToken } = require('../middleware/auth');
const User = require('../models/User');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const PharmacyStock = require('../models/PharmacyStock');
const Prescription = require('../models/Prescription');
const PharmacyOrder = require('../models/PharmacyOrder');
const Reminder = require('../models/Reminder');
const Delivery = require('../models/Delivery');

const JWT_SECRET = 'chain-test-jwt-secret-at-least-32-chars-long';

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

  // Mount routes exactly as in server.js
  const { pharmacyAuth, courierAuth } = require('../routes/pharmacyAuthRoutes');
  const { prescriptions, pharmacies } = require('../routes/prescriptionRoutes');
  const pharmacyRoutes = require('../routes/pharmacyRoutes');
  const courierRoutes = require('../routes/courierRoutes');
  const patientPharmacyRoutes = require('../routes/patientPharmacyRoutes');
  const reminderRoutes = require('../routes/reminderRoutes');
  const { requireAuth, requirePharmacist, requireCourier } = require('../middleware/auth');

  app.use('/api/pharmacy-auth', pharmacyAuth);
  app.use('/api/courier-auth', courierAuth);
  app.use('/api/pharmacy', requirePharmacist, pharmacyRoutes);
  app.use('/api/courier', requireCourier, courierRoutes);
  app.use('/api/prescriptions', requireAuth, prescriptions);
  app.use('/api/pharmacies', requireAuth, pharmacies);
  app.use('/api/patient-app', patientPharmacyRoutes);
  app.use('/api/reminders', reminderRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

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

  // Seed doctor user
  const doc = await User.create({
    email: 'doc@medicluster.org',
    name: 'Dr. Smith',
    passwordHash: 'irrelevant-hash',
    role: 'doctor',
  });
  const clinicianToken = signToken(doc);

  // Seed pharmacy
  const pharmacy = await Pharmacy.create({
    name: 'MediCluster Main Pharmacy',
    address: '100 Hospital Blvd',
    lat: 12.971,
    lng: 77.592,
    phone: '555-0100',
    active: true,
  });

  // Seed pharmacist staff
  const pharmPwHash = await bcrypt.hash('secret123', 10);
  const pharmacist = await PharmacyStaff.create({
    name: 'Alice Pharmacist',
    role: 'pharmacist',
    email: 'alice@pharma.org',
    passwordHash: pharmPwHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });
  const pharmacistToken = signStaffToken(pharmacist);

  // Seed courier staff
  const courierPinHash = await bcrypt.hash('1234', 10);
  const courier = await PharmacyStaff.create({
    name: 'Bob Courier',
    role: 'courier',
    phone: '+919999900010',
    passwordHash: courierPinHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });
  const courierToken = signStaffToken(courier);

  // Stock the pharmacy
  await PharmacyStock.create({
    pharmacyId: String(pharmacy._id),
    drug: 'Amoxicillin',
    quantity: 50,
  });

  await PharmacyStock.create({
    pharmacyId: String(pharmacy._id),
    drug: 'Lisinopril',
    quantity: 50,
  });

  return {
    api,
    clinicianToken,
    pharmacistToken,
    courierToken,
    pharmacy,
    pharmacist,
    courier,
  };
}

test('end-to-end order chain: clinician prescribes -> patient orders delivery -> pharmacist prepares/assigns -> courier delivers -> patient verified -> prescription fulfilled', async (t) => {
  const { api, clinicianToken, pharmacistToken, courierToken, pharmacy, courier } = await setup(t);
  const patientId = 'pat_chain_1';
  const patientToken = signPatientToken(patientId);

  // 1. Clinician prescribes Amoxicillin
  const rxRes = await api('/api/prescriptions', 'POST', {
    patientId,
    items: [
      { drug: 'Amoxicillin', dose: '500mg', quantity: 10, instructions: 'Take 1 capsule three times daily' },
    ],
    notes: 'Mild infection',
  }, clinicianToken);
  assert.equal(rxRes.status, 201);
  const prescriptionId = rxRes.body._id;
  assert.equal(rxRes.body.status, 'active');

  // 2. Patient orders delivery from pharmacy
  const orderRes = await api(`/api/patient-app/${patientId}/orders`, 'POST', {
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId },
    fulfilment: 'delivery',
    deliveryAddress: { text: '42 Baker Street', lat: 12.975, lng: 77.595 },
  }, patientToken);
  assert.equal(orderRes.status, 201);
  const orderId = orderRes.body._id;
  assert.equal(orderRes.body.status, 'new');

  // 3. Pharmacist accepts the order
  const acceptRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', {
    action: 'accept',
  }, pharmacistToken);
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.body.order.status, 'accepted');

  // 4. Pharmacist starts preparing
  const startRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', {
    action: 'start',
  }, pharmacistToken);
  assert.equal(startRes.status, 200);
  assert.equal(startRes.body.order.status, 'preparing');

  // 5. Pharmacist marks order ready (generates OTP stored for patient)
  const readyRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', {
    action: 'ready',
  }, pharmacistToken);
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.body.order.status, 'ready');

  // Patient views order at ready: handoverOtp is available, no courier location
  let patView = await api(`/api/patient-app/${patientId}/orders/${orderId}`, 'GET', undefined, patientToken);
  assert.equal(patView.status, 200);
  const generatedOtp = patView.body.handoverOtp;
  assert.ok(generatedOtp);
  assert.equal(patView.body.courierLocation, undefined);

  // 6. Pharmacist assigns courier
  const assignRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', {
    action: 'assign_courier',
    courierId: String(courier._id),
  }, pharmacistToken);
  assert.equal(assignRes.status, 200);

  // 7. Courier lists deliveries and accepts
  const delList = await api('/api/courier/deliveries', 'GET', undefined, courierToken);
  assert.equal(delList.status, 200);
  assert.equal(delList.body.length, 1);
  const deliveryId = delList.body[0]._id;
  assert.equal(delList.body[0].status, 'assigned');

  const acceptDel = await api(`/api/courier/deliveries/${deliveryId}/accept`, 'POST', {}, courierToken);
  assert.equal(acceptDel.status, 200);
  assert.equal(acceptDel.body.delivery.status, 'accepted');

  // 8. Courier picks up order -> status becomes out_for_delivery
  const pickupRes = await api(`/api/courier/deliveries/${deliveryId}/actions`, 'POST', {
    action: 'pickup',
  }, courierToken);
  assert.equal(pickupRes.status, 200);
  assert.equal(pickupRes.body.order.status, 'out_for_delivery');

  // 9. Courier posts location fix
  const locRes = await api(`/api/courier/deliveries/${deliveryId}/location`, 'POST', {
    lat: 12.973,
    lng: 77.593,
    accuracy: 8,
    observedAt: new Date().toISOString(),
  }, courierToken);
  assert.equal(locRes.status, 200);

  // Patient sees courier location and handoverOtp
  patView = await api(`/api/patient-app/${patientId}/orders/${orderId}`, 'GET', undefined, patientToken);
  assert.equal(patView.status, 200);
  assert.equal(patView.body.status, 'out_for_delivery');
  assert.equal(patView.body.handoverOtp, generatedOtp);
  assert.ok(patView.body.courierLocation);
  assert.equal(patView.body.courierLocation.lat, 12.973);

  // 10. Courier delivers with the patient's OTP
  const deliverRes = await api(`/api/courier/deliveries/${deliveryId}/actions`, 'POST', {
    action: 'deliver',
    otp: generatedOtp,
  }, courierToken);
  assert.equal(deliverRes.status, 200);
  assert.equal(deliverRes.body.order.status, 'delivered');

  // 11. Patient sees delivered: courierLocation and handoverOtp are absent
  patView = await api(`/api/patient-app/${patientId}/orders/${orderId}`, 'GET', undefined, patientToken);
  assert.equal(patView.status, 200);
  assert.equal(patView.body.status, 'delivered');
  assert.equal(patView.body.handoverOtp, undefined);
  assert.equal(patView.body.courierLocation, undefined);

  // 12. Prescription status has transitioned to fulfilled
  const rxCheck = await api('/api/prescriptions', 'GET', undefined, clinicianToken);
  assert.equal(rxCheck.status, 200);
  const foundRx = rxCheck.body.find(r => r._id === prescriptionId);
  assert.ok(foundRx);
  assert.equal(foundRx.status, 'fulfilled');
});

test('end-to-end refill flow: patient creates refill from reminder -> pharmacist accepts/readies -> pharmacist handovers with OTP', async (t) => {
  const { api, pharmacistToken, pharmacy } = await setup(t);
  const patientId = 'pat_chain_2';
  const patientToken = signPatientToken(patientId);

  // 1. Patient has an active reminder
  const reminder = await Reminder.create({
    patientId,
    medicationName: 'Lisinopril',
    dosage: '10mg',
    times: ['09:00'],
    frequency: 'daily',
    pillsLeft: 3,
  });

  // 2. Patient requests refill via PATCH /api/reminders/:id with refillPharmacyId
  const refillReq = await api(`/api/reminders/${reminder._id}`, 'PATCH', {
    refillPharmacyId: String(pharmacy._id),
    fulfilment: 'pickup',
  }, patientToken);
  assert.equal(refillReq.status, 200);
  const orderId = refillReq.body.refillOrderId;
  assert.ok(orderId);

  // 3. Pharmacist accepts, starts, and readies order
  await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', { action: 'accept' }, pharmacistToken);
  await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', { action: 'start' }, pharmacistToken);
  const readyRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', { action: 'ready' }, pharmacistToken);
  assert.equal(readyRes.status, 200);

  // Patient views order: sees handoverOtp
  const patView = await api(`/api/patient-app/${patientId}/orders/${orderId}`, 'GET', undefined, patientToken);
  assert.equal(patView.status, 200);
  const otp = patView.body.handoverOtp;
  assert.ok(otp);

  // 4. Patient arrives at pharmacy, pharmacist executes handover with OTP
  const handoverRes = await api(`/api/pharmacy/orders/${orderId}/actions`, 'POST', {
    action: 'handover',
    otp,
  }, pharmacistToken);
  assert.equal(handoverRes.status, 200);
  assert.equal(handoverRes.body.order.status, 'picked_up');

  // Patient views order after pickup: handoverOtp is gone
  const afterView = await api(`/api/patient-app/${patientId}/orders/${orderId}`, 'GET', undefined, patientToken);
  assert.equal(afterView.status, 200);
  assert.equal(afterView.body.status, 'picked_up');
  assert.equal(afterView.body.handoverOtp, undefined);
});
