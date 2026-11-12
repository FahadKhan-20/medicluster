const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signPatientToken, signToken, signStaffToken } = require('../middleware/auth');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const Prescription = require('../models/Prescription');
const PharmacyOrder = require('../models/PharmacyOrder');
const PharmacyStock = require('../models/PharmacyStock');
const Delivery = require('../models/Delivery');
const Reminder = require('../models/Reminder');
const { applyAction } = require('../services/pharmacyOrderStore');

const JWT_SECRET = 'patient-pharmacy-test-jwt-secret-at-least-32-chars';

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
  app.use('/api/patient-app', require('../routes/patientPharmacyRoutes'));
  app.use('/api/patient-app', require('../routes/patientFeatureRoutes'));
  app.use('/api/patient-app', require('../routes/patientAppRoutes'));
  app.use('/api/reminders', require('../routes/reminderRoutes'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  const patientAppOrigin = `http://127.0.0.1:${port}/api/patient-app`;
  const remindersOrigin = `http://127.0.0.1:${port}/api/reminders`;

  async function callPatientApp(path, method = 'GET', body, token = signPatientToken('pat_101')) {
    const res = await fetch(`${patientAppOrigin}${path}`, {
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

  async function callReminders(path, method = 'GET', body, token = signPatientToken('pat_101')) {
    const res = await fetch(`${remindersOrigin}${path}`, {
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

  // Seed 2 pharmacies
  const pharmFar = await Pharmacy.create({
    name: 'Zeta Pharmacy North',
    address: '99 North Way',
    lat: 13.100,
    lng: 77.600,
    phone: '555-0999',
    active: true,
  });

  const pharmNear = await Pharmacy.create({
    name: 'Alpha Pharmacy Central',
    address: '10 Central Way',
    lat: 12.972,
    lng: 77.594,
    phone: '555-0111',
    active: true,
  });

  const pharmInactive = await Pharmacy.create({
    name: 'Inactive Pharmacy',
    address: '0 Closed Rd',
    lat: 12.970,
    lng: 77.590,
    phone: '555-0000',
    active: false,
  });

  return {
    callPatientApp,
    callReminders,
    pharmFar,
    pharmNear,
    pharmInactive,
  };
}

test('other patient 403 on patient-app pharmacy routes', async (t) => {
  const { callPatientApp } = await setup(t);
  const p1Token = signPatientToken('pat_101');
  // pat_101 tries to access pat_202's routes
  const res = await callPatientApp('/pat_202/orders', 'GET', undefined, p1Token);
  assert.equal(res.status, 403);
});

test('pharmacies listing sorted by distance with coords, or by name without', async (t) => {
  const { callPatientApp } = await setup(t);

  // Without coordinates: sorted by name
  const resName = await callPatientApp('/pat_101/pharmacies');
  assert.equal(resName.status, 200);
  assert.equal(resName.body.length, 2); // inactive excluded
  assert.equal(resName.body[0].name, 'Alpha Pharmacy Central');
  assert.equal(resName.body[1].name, 'Zeta Pharmacy North');

  // With coordinates close to Central (12.971, 77.593)
  const resDist = await callPatientApp('/pat_101/pharmacies?lat=12.971&lng=77.593');
  assert.equal(resDist.status, 200);
  assert.equal(resDist.body.length, 2);
  assert.equal(resDist.body[0].name, 'Alpha Pharmacy Central');
  assert.ok(typeof resDist.body[0].distanceKm === 'number');
  assert.ok(resDist.body[0].distanceKm < resDist.body[1].distanceKm);
});

test('order creation and validation: prescription, cancelled prescription, delivery address', async (t) => {
  const { callPatientApp, pharmNear } = await setup(t);

  // 1. Create prescription for pat_101
  const rx = await Prescription.create({
    patientId: 'pat_101',
    doctorUserId: 'doc_1',
    items: [{ drug: 'Amoxicillin', dose: '500mg', quantity: 20 }],
    status: 'active',
  });

  // 2. Delivery without valid address should 400
  const noAddr = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(rx._id) },
    fulfilment: 'delivery',
  });
  assert.equal(noAddr.status, 400);

  // 3. Delivery with valid address succeeds (201)
  const okDelivery = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(rx._id) },
    fulfilment: 'delivery',
    deliveryAddress: { text: '123 Main St, Apt 4B', lat: 12.975, lng: 77.595 },
  });
  assert.equal(okDelivery.status, 201);
  assert.equal(okDelivery.body.status, 'new');
  assert.equal(okDelivery.body.items.length, 1);
  assert.equal(okDelivery.body.items[0].drug, 'Amoxicillin');

  // 4. Cancelled prescription should fail (400)
  const cancelledRx = await Prescription.create({
    patientId: 'pat_101',
    doctorUserId: 'doc_1',
    items: [{ drug: 'Metformin', quantity: 30 }],
    status: 'cancelled',
  });
  const badRxOrder = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(cancelledRx._id) },
    fulfilment: 'pickup',
  });
  assert.equal(badRxOrder.status, 400);
});

test('order detail visibility: handoverOtp only at ready/out_for_delivery, courierLocation only at out_for_delivery, absent at delivered', async (t) => {
  const { callPatientApp, pharmNear } = await setup(t);

  const rx = await Prescription.create({
    patientId: 'pat_101',
    doctorUserId: 'doc_1',
    items: [{ drug: 'Cetirizine', quantity: 10 }],
    status: 'active',
  });

  const createRes = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(rx._id) },
    fulfilment: 'delivery',
    deliveryAddress: { text: '789 Oak St', lat: 12.973, lng: 77.595 },
  });
  assert.equal(createRes.status, 201);
  const orderId = createRes.body._id;

  // At "new": no handoverOtp, no courierLocation
  let detail = await callPatientApp(`/pat_101/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.handoverOtp, undefined);
  assert.equal(detail.body.courierLocation, undefined);

  // Pharmacist accepts and prepares and readies
  await PharmacyStock.create({
    pharmacyId: String(pharmNear._id),
    drug: 'Cetirizine',
    quantity: 100,
  });

  await applyAction(orderId, 'accept', { id: 'pharm_staff_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });
  await applyAction(orderId, 'start', { id: 'pharm_staff_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });
  const readyResult = await applyAction(orderId, 'ready', { id: 'pharm_staff_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });
  assert.ok(readyResult.otp);

  // At "ready": handoverOtp present, no courierLocation
  detail = await callPatientApp(`/pat_101/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.handoverOtp, readyResult.otp);
  assert.equal(detail.body.courierLocation, undefined);

  // Assign courier and courier_pickup -> out_for_delivery
  await applyAction(orderId, 'assign_courier', { id: 'pharm_staff_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] }, { courierId: 'courier_1' });
  const delivery = await Delivery.findOne({ orderId }).lean();
  await Delivery.findByIdAndUpdate(delivery._id, { status: 'accepted' });
  await applyAction(orderId, 'courier_pickup', { id: 'courier_1', kind: 'courier' });

  // Update delivery location
  await Delivery.findByIdAndUpdate(delivery._id, {
    lastLocation: { lat: 12.974, lng: 77.596, accuracy: 5, observedAt: new Date() },
  });

  // At "out_for_delivery": handoverOtp present, courierLocation present
  detail = await callPatientApp(`/pat_101/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.handoverOtp, readyResult.otp);
  assert.ok(detail.body.courierLocation);
  assert.equal(detail.body.courierLocation.lat, 12.974);

  // Deliver with OTP
  await applyAction(orderId, 'deliver', { id: 'courier_1', kind: 'courier' }, { otp: readyResult.otp });

  // At "delivered": handoverOtp absent, courierLocation absent
  detail = await callPatientApp(`/pat_101/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'delivered');
  assert.equal(detail.body.handoverOtp, undefined);
  assert.equal(detail.body.courierLocation, undefined);
});

test('cancellation: allowed at new, 409 at ready', async (t) => {
  const { callPatientApp, pharmNear } = await setup(t);

  const rx1 = await Prescription.create({
    patientId: 'pat_101',
    doctorUserId: 'doc_1',
    items: [{ drug: 'Paracetamol', quantity: 10 }],
    status: 'active',
  });

  // Order 1: Cancel at "new"
  const ord1 = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(rx1._id) },
    fulfilment: 'pickup',
  });
  const cancelRes = await callPatientApp(`/pat_101/orders/${ord1.body._id}/cancel`, 'POST');
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'cancelled');

  // Order 2: Advance to "ready", then cancel fails with 409
  const rx2 = await Prescription.create({
    patientId: 'pat_101',
    doctorUserId: 'doc_1',
    items: [{ drug: 'Ibuprofen', quantity: 10 }],
    status: 'active',
  });
  const ord2 = await callPatientApp('/pat_101/orders', 'POST', {
    pharmacyId: String(pharmNear._id),
    source: { type: 'prescription', prescriptionId: String(rx2._id) },
    fulfilment: 'pickup',
  });
  await applyAction(ord2.body._id, 'accept', { id: 'pharm_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });
  await applyAction(ord2.body._id, 'start', { id: 'pharm_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });
  await applyAction(ord2.body._id, 'ready', { id: 'pharm_1', kind: 'pharmacy', pharmacyIds: [String(pharmNear._id)] });

  const failCancel = await callPatientApp(`/pat_101/orders/${ord2.body._id}/cancel`, 'POST');
  assert.equal(failCancel.status, 409);
});

test('reminder PATCH: with refillPharmacyId creates order, without it preserves standard reminder update', async (t) => {
  const { callReminders, pharmNear } = await setup(t);

  const reminder = await Reminder.create({
    patientId: 'pat_101',
    medicationName: 'Atorvastatin',
    dosage: '20mg',
    times: ['08:00'],
    frequency: 'daily',
    pillsLeft: 5,
  });

  // Standard update without refillPharmacyId
  const stdPatch = await callReminders(`/${reminder._id}`, 'PATCH', {
    notes: 'Take with dinner',
  });
  assert.equal(stdPatch.status, 200);
  assert.equal(stdPatch.body.notes, 'Take with dinner');
  assert.equal(stdPatch.body.refillOrderId, undefined);

  // Refill order creation via PATCH
  const refillPatch = await callReminders(`/${reminder._id}`, 'PATCH', {
    refillPharmacyId: String(pharmNear._id),
    fulfilment: 'pickup',
  });
  assert.equal(refillPatch.status, 200);
  assert.ok(refillPatch.body.refillOrderId);

  // Verify created PharmacyOrder
  const order = await PharmacyOrder.findById(refillPatch.body.refillOrderId).lean();
  assert.ok(order);
  assert.equal(order.patientId, 'pat_101');
  assert.equal(order.source.type, 'refill');
  assert.equal(order.source.reminderId, String(reminder._id));
  assert.equal(order.items[0].drug, 'Atorvastatin');
  assert.equal(order.items[0].dose, '20mg');
});
