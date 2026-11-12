const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signStaffToken, requireCourier } = require('../middleware/auth');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const PharmacyOrder = require('../models/PharmacyOrder');
const Delivery = require('../models/Delivery');
const courierRoutes = require('../routes/courierRoutes');
const { _setTestOtp } = require('../services/pharmacyOrderStore');
const { hashOtp } = require('../services/pharmacyOrders');

const JWT_SECRET = 'courier-routes-test-jwt-secret-at-least-32-chars';

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
    name: 'MediCluster Express Pharmacy',
    address: '500 Delivery Way',
    lat: 12.971,
    lng: 77.592,
    phone: '555-0150',
    active: true,
  });

  const pinHash = await bcrypt.hash('1234', 10);
  const courier1 = await PharmacyStaff.create({
    name: 'Dave Courier',
    role: 'courier',
    phone: '+919999900021',
    passwordHash: pinHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });

  const courier2 = await PharmacyStaff.create({
    name: 'Eve Courier',
    role: 'courier',
    phone: '+919999900022',
    passwordHash: pinHash,
    pharmacyIds: [String(pharmacy._id)],
    active: true,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/courier', requireCourier, courierRoutes);
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
    const text = await res.text();
    let parsedBody = null;
    try { parsedBody = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: parsedBody };
  };

  const token1 = signStaffToken(courier1);
  const token2 = signStaffToken(courier2);

  return { call, pharmacy, courier1, courier2, token1, token2 };
}

test('courier sees only own deliveries and other courier gets 403', async t => {
  const { call, pharmacy, courier1, courier2, token1, token2 } = await setup(t);

  const order1 = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'DrugA', quantity: 1 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '1 Main St', lat: 12.97, lng: 77.59 },
    courierId: String(courier1._id),
    status: 'ready',
  });

  const delivery1 = await Delivery.create({
    orderId: String(order1._id),
    courierId: String(courier1._id),
    status: 'assigned',
  });

  // Courier 1 lists deliveries -> sees delivery1
  const listRes1 = await call('GET', '/api/courier/deliveries', token1);
  assert.equal(listRes1.status, 200);
  assert.equal(listRes1.body.length, 1);
  assert.equal(listRes1.body[0]._id, String(delivery1._id));

  // Courier 2 lists deliveries -> empty
  const listRes2 = await call('GET', '/api/courier/deliveries', token2);
  assert.equal(listRes2.status, 200);
  assert.equal(listRes2.body.length, 0);

  // Courier 2 tries GET delivery1 -> 403
  assert.equal((await call('GET', `/api/courier/deliveries/${delivery1._id}`, token2)).status, 403);

  // Courier 2 tries accept delivery1 -> 403
  assert.equal((await call('POST', `/api/courier/deliveries/${delivery1._id}/accept`, token2)).status, 403);

  // Courier 2 tries action on delivery1 -> 403
  assert.equal(
    (await call('POST', `/api/courier/deliveries/${delivery1._id}/actions`, token2, { action: 'pickup' })).status,
    403
  );

  // Courier 2 tries location on delivery1 -> 403
  assert.equal(
    (await call('POST', `/api/courier/deliveries/${delivery1._id}/location`, token2, {
      lat: 12.97,
      lng: 77.59,
      observedAt: new Date().toISOString(),
    })).status,
    403
  );
});

test('full courier delivery path: accept -> pickup -> location -> deliver with OTP', async t => {
  const { call, pharmacy, courier1, token1 } = await setup(t);

  const otp = '7890';
  _setTestOtp('ord-full', otp);

  const order = await PharmacyOrder.create({
    _id: 'ord-full',
    patientId: 'pat-10',
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId: 'rx-10' },
    items: [{ drug: 'Insulin', quantity: 2 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '10 Hospital Rd', lat: 12.97, lng: 77.59 },
    courierId: String(courier1._id),
    status: 'ready',
    handoverOtpHash: hashOtp(otp),
  });

  const delivery = await Delivery.create({
    orderId: String(order._id),
    courierId: String(courier1._id),
    status: 'assigned',
  });

  // 1. Accept
  const acceptRes = await call('POST', `/api/courier/deliveries/${delivery._id}/accept`, token1);
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.body.delivery.status, 'accepted');

  // 2. Pickup
  const pickupRes = await call('POST', `/api/courier/deliveries/${delivery._id}/actions`, token1, {
    action: 'pickup',
  });
  assert.equal(pickupRes.status, 200);
  assert.equal(pickupRes.body.delivery.status, 'picked_up');
  assert.equal(pickupRes.body.order.status, 'out_for_delivery');

  // 3. Location update
  const t1 = new Date('2026-11-13T10:00:00.000Z').toISOString();
  const locRes = await call('POST', `/api/courier/deliveries/${delivery._id}/location`, token1, {
    lat: 12.972,
    lng: 77.593,
    accuracy: 5,
    observedAt: t1,
  });
  assert.equal(locRes.status, 200);
  assert.equal(locRes.body.delivery.lastLocation.lat, 12.972);

  // 4. Deliver with OTP
  const deliverRes = await call('POST', `/api/courier/deliveries/${delivery._id}/actions`, token1, {
    action: 'deliver',
    otp,
  });
  assert.equal(deliverRes.status, 200);
  assert.equal(deliverRes.body.delivery.status, 'delivered');
  assert.equal(deliverRes.body.delivery.proof.kind, 'otp');
  assert.equal(deliverRes.body.order.status, 'delivered');
});

test('deliver with photoMediaId instead of OTP', async t => {
  const { call, pharmacy, courier1, token1 } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-11',
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId: 'rx-11' },
    items: [{ drug: 'Bandages', quantity: 1 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '11 Park Ln', lat: 12.97, lng: 77.59 },
    courierId: String(courier1._id),
    status: 'ready',
  });

  const delivery = await Delivery.create({
    orderId: String(order._id),
    courierId: String(courier1._id),
    status: 'accepted',
  });

  await call('POST', `/api/courier/deliveries/${delivery._id}/actions`, token1, { action: 'pickup' });

  const deliverRes = await call('POST', `/api/courier/deliveries/${delivery._id}/actions`, token1, {
    action: 'deliver',
    photoMediaId: 'photo-dropoff-1',
  });
  assert.equal(deliverRes.status, 200);
  assert.equal(deliverRes.body.delivery.status, 'delivered');
  assert.equal(deliverRes.body.delivery.proof.kind, 'photo');
  assert.equal(deliverRes.body.delivery.proof.mediaId, 'photo-dropoff-1');
});

test('older location fix ignored (204) and location after delivered returns 409', async t => {
  const { call, pharmacy, courier1, token1 } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-12',
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId: 'rx-12' },
    items: [{ drug: 'DrugB', quantity: 1 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '12 Hill Rd', lat: 12.97, lng: 77.59 },
    courierId: String(courier1._id),
    status: 'out_for_delivery',
  });

  const tNewer = new Date('2026-11-13T12:00:00.000Z');
  const delivery = await Delivery.create({
    orderId: String(order._id),
    courierId: String(courier1._id),
    status: 'picked_up',
    lastLocation: { lat: 12.97, lng: 77.59, accuracy: 10, observedAt: tNewer },
  });

  // 1. Older fix -> 204
  const tOlder = new Date('2026-11-13T11:59:00.000Z').toISOString();
  const olderRes = await call('POST', `/api/courier/deliveries/${delivery._id}/location`, token1, {
    lat: 12.971,
    lng: 77.591,
    observedAt: tOlder,
  });
  assert.equal(olderRes.status, 204);

  // Deliver the order
  await call('POST', `/api/courier/deliveries/${delivery._id}/actions`, token1, {
    action: 'deliver',
    photoMediaId: 'photo-1',
  });

  // 2. Location update after delivered -> 409
  const afterDeliveredRes = await call('POST', `/api/courier/deliveries/${delivery._id}/location`, token1, {
    lat: 12.975,
    lng: 77.595,
    observedAt: new Date('2026-11-13T12:05:00.000Z').toISOString(),
  });
  assert.equal(afterDeliveredRes.status, 409);
});

test('location rejects out-of-range lat or lng with 400', async t => {
  const { call, pharmacy, courier1, token1 } = await setup(t);

  const delivery = await Delivery.create({
    orderId: 'dummy-ord',
    courierId: String(courier1._id),
    status: 'accepted',
  });

  // Lat out of range
  const badLat = await call('POST', `/api/courier/deliveries/${delivery._id}/location`, token1, {
    lat: 91,
    lng: 77.59,
    observedAt: new Date().toISOString(),
  });
  assert.equal(badLat.status, 400);

  // Lng out of range
  const badLng = await call('POST', `/api/courier/deliveries/${delivery._id}/location`, token1, {
    lat: 12.97,
    lng: 181,
    observedAt: new Date().toISOString(),
  });
  assert.equal(badLng.status, 400);
});

test('courier response has no clinical fields', async t => {
  const { call, pharmacy, courier1, token1 } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-secret',
    pharmacyId: String(pharmacy._id),
    source: { type: 'prescription', prescriptionId: 'rx-confidential' },
    items: [{ drug: 'Confidential Medication', quantity: 100 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '99 Secret Blvd', lat: 12.97, lng: 77.59 },
    courierId: String(courier1._id),
    status: 'ready',
    patientFirstName: 'John',
    patientPhone: '+919876543210',
  });

  const delivery = await Delivery.create({
    orderId: String(order._id),
    courierId: String(courier1._id),
    status: 'assigned',
  });

  const res = await call('GET', `/api/courier/deliveries/${delivery._id}`, token1);
  assert.equal(res.status, 200);
  assert.ok(res.body.order);

  // Assert keys of order: only allowed courier fields
  const allowedKeys = new Set([
    '_id',
    'status',
    'fulfilment',
    'deliveryAddress',
    'pharmacyId',
    'patientFirstName',
    'patientPhone',
  ]);

  for (const key of Object.keys(res.body.order)) {
    assert.ok(allowedKeys.has(key), `Key ${key} should not be present in courier view`);
  }
  assert.equal(res.body.order.items, undefined);
  assert.equal(res.body.order.source, undefined);
});
