const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signStaffToken, requirePharmacist } = require('../middleware/auth');
const Pharmacy = require('../models/Pharmacy');
const PharmacyStaff = require('../models/PharmacyStaff');
const PharmacyOrder = require('../models/PharmacyOrder');
const PharmacyStock = require('../models/PharmacyStock');
const Delivery = require('../models/Delivery');
const pharmacyRoutes = require('../routes/pharmacyRoutes');
const { _getTestOtp } = require('../services/pharmacyOrderStore');

const JWT_SECRET = 'pharmacy-routes-test-jwt-secret-at-least-32-chars';

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

  const pharmacyA = await Pharmacy.create({
    name: 'Pharmacy A',
    address: '100 Main St',
    lat: 12.97,
    lng: 77.59,
    phone: '555-0101',
    active: true,
  });

  const pharmacyB = await Pharmacy.create({
    name: 'Pharmacy B',
    address: '200 Other St',
    lat: 12.98,
    lng: 77.60,
    phone: '555-0102',
    active: true,
  });

  const passwordHash = await bcrypt.hash('secret123', 10);
  const pharmacistA = await PharmacyStaff.create({
    name: 'Pharmacist A',
    role: 'pharmacist',
    email: 'pharma.a@test.local',
    passwordHash,
    pharmacyIds: [String(pharmacyA._id)],
    active: true,
  });

  const courierA = await PharmacyStaff.create({
    name: 'Courier A',
    role: 'courier',
    phone: '+919999900010',
    passwordHash,
    pharmacyIds: [String(pharmacyA._id)],
    active: true,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/pharmacy', requirePharmacist, pharmacyRoutes);
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

  const tokenA = signStaffToken(pharmacistA);

  return {
    call,
    pharmacyA,
    pharmacyB,
    pharmacistA,
    courierA,
    tokenA,
  };
}

test('queue filtered by status', async t => {
  const { call, pharmacyA, tokenA } = await setup(t);

  await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Paracetamol', quantity: 10 }],
    fulfilment: 'pickup',
    status: 'new',
  });

  await PharmacyOrder.create({
    patientId: 'pat-2',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-2' },
    items: [{ drug: 'Ibuprofen', quantity: 5 }],
    fulfilment: 'pickup',
    status: 'preparing',
  });

  const allRes = await call('GET', `/api/pharmacy/orders?pharmacyId=${pharmacyA._id}`, tokenA);
  assert.equal(allRes.status, 200);
  assert.equal(allRes.body.length, 2);

  const newRes = await call('GET', `/api/pharmacy/orders?pharmacyId=${pharmacyA._id}&status=new`, tokenA);
  assert.equal(newRes.status, 200);
  assert.equal(newRes.body.length, 1);
  assert.equal(newRes.body[0].status, 'new');

  // Verify response never contains handoverOtpHash
  assert.equal(newRes.body[0].handoverOtpHash, undefined);
});

test('full pickup path: accept -> start -> ready -> handover with correct OTP', async t => {
  const { call, pharmacyA, tokenA } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Amoxicillin', quantity: 20 }],
    fulfilment: 'pickup',
    status: 'new',
  });

  // 1. Accept
  const acceptRes = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'accept' });
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.body.order.status, 'accepted');

  // 2. Start
  const startRes = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'start' });
  assert.equal(startRes.status, 200);
  assert.equal(startRes.body.order.status, 'preparing');

  // 3. Ready
  const readyRes = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'ready' });
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.body.order.status, 'ready');
  assert.equal(readyRes.body.otp, undefined, 'Pharmacist response must NOT leak plain OTP');
  assert.equal(readyRes.body.order.handoverOtpHash, undefined);

  // Read plain OTP from test hook
  const plainOtp = _getTestOtp(String(order._id));
  assert.ok(plainOtp);

  // 4. Handover
  const handoverRes = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, {
    action: 'handover',
    otp: plainOtp,
  });
  assert.equal(handoverRes.status, 200);
  assert.equal(handoverRes.body.order.status, 'picked_up');
});

test('wrong OTP 400 x5 then 429 and status still ready', async t => {
  const { call, pharmacyA, tokenA } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Amoxicillin', quantity: 5 }],
    fulfilment: 'pickup',
    status: 'preparing',
  });

  await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'ready' });

  // 5 wrong attempts
  for (let i = 1; i <= 5; i++) {
    const res = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, {
      action: 'handover',
      otp: '0000',
    });
    assert.equal(res.status, 400, `Attempt ${i} should be 400`);
    assert.deepEqual(res.body, { error: 'Wrong code' });
  }

  // 6th attempt -> 429
  const sixthRes = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, {
    action: 'handover',
    otp: '0000',
  });
  assert.equal(sixthRes.status, 429);

  // Status must remain ready
  const check = await PharmacyOrder.findById(order._id).lean();
  assert.equal(check.status, 'ready');
});

test('assign courier creates a Delivery', async t => {
  const { call, pharmacyA, courierA, tokenA } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Amoxicillin', quantity: 5 }],
    fulfilment: 'delivery',
    deliveryAddress: { text: '123 Test St', lat: 12.97, lng: 77.59 },
    status: 'ready',
  });

  const res = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, {
    action: 'assign_courier',
    courierId: String(courierA._id),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.courierId, String(courierA._id));

  const delivery = await Delivery.findOne({ orderId: String(order._id) }).lean();
  assert.ok(delivery);
  assert.equal(delivery.courierId, String(courierA._id));
  assert.equal(delivery.status, 'assigned');
});

test("other pharmacy's order returns 403 on GET and actions", async t => {
  const { call, pharmacyB, tokenA } = await setup(t);

  const orderB = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyB._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Amoxicillin', quantity: 5 }],
    fulfilment: 'pickup',
    status: 'new',
  });

  const getRes = await call('GET', `/api/pharmacy/orders/${orderB._id}`, tokenA);
  assert.equal(getRes.status, 403);

  const actionRes = await call('POST', `/api/pharmacy/orders/${orderB._id}/actions`, tokenA, {
    action: 'accept',
  });
  assert.equal(actionRes.status, 403);

  const listRes = await call('GET', `/api/pharmacy/orders?pharmacyId=${pharmacyB._id}`, tokenA);
  assert.equal(listRes.status, 403);
});

test('double accept: second returns 409 and statusHistory has one accepted entry', async t => {
  const { call, pharmacyA, tokenA } = await setup(t);

  const order = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [{ drug: 'Amoxicillin', quantity: 5 }],
    fulfilment: 'pickup',
    status: 'new',
  });

  const first = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'accept' });
  assert.equal(first.status, 200);

  const second = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'accept' });
  assert.equal(second.status, 409);

  const doc = await PharmacyOrder.findById(order._id).lean();
  assert.equal(doc.statusHistory.filter(h => h.status === 'accepted').length, 1);
});

test('ready decrements stock and returns stockWarnings for unstocked drug', async t => {
  const { call, pharmacyA, tokenA } = await setup(t);

  // Stock: 15 pills of Amoxicillin
  await PharmacyStock.create({
    pharmacyId: String(pharmacyA._id),
    drug: 'Amoxicillin',
    quantity: 15,
  });

  // Order wants 10 Amoxicillin and 5 Ibuprofen (unstocked)
  const order = await PharmacyOrder.create({
    patientId: 'pat-1',
    pharmacyId: String(pharmacyA._id),
    source: { type: 'prescription', prescriptionId: 'rx-1' },
    items: [
      { drug: 'Amoxicillin', quantity: 10 },
      { drug: 'Ibuprofen', quantity: 5 },
    ],
    fulfilment: 'pickup',
    status: 'preparing',
  });

  const res = await call('POST', `/api/pharmacy/orders/${order._id}/actions`, tokenA, { action: 'ready' });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'ready');
  assert.ok(Array.isArray(res.body.stockWarnings));
  assert.equal(res.body.stockWarnings.length, 1);
  assert.equal(res.body.stockWarnings[0].drug, 'Ibuprofen');

  // Verify Amoxicillin stock decremented to 5
  const stock = await PharmacyStock.findOne({ pharmacyId: String(pharmacyA._id), drug: 'Amoxicillin' }).lean();
  assert.equal(stock.quantity, 5);
});

test('stock add, adjust, lookup by barcode, and couriers list', async t => {
  const { call, pharmacyA, courierA, tokenA } = await setup(t);

  // 1. Add stock
  const addRes = await call('POST', '/api/pharmacy/stock', tokenA, {
    pharmacyId: String(pharmacyA._id),
    drug: 'Cetirizine',
    strength: '10mg',
    barcode: '8901234567890',
    quantity: 50,
    batch: 'B123',
    expiry: '2027-12-31',
  });
  assert.equal(addRes.status, 201);
  const stockId = addRes.body._id;

  // 2. Adjust stock
  const adjustRes = await call('PATCH', `/api/pharmacy/stock/${stockId}`, tokenA, {
    quantity: 45,
    lowStockThreshold: 15,
  });
  assert.equal(adjustRes.status, 200);
  assert.equal(adjustRes.body.quantity, 45);
  assert.equal(adjustRes.body.lowStockThreshold, 15);

  // 3. Lookup by barcode
  const lookupRes = await call(
    'GET',
    `/api/pharmacy/stock?pharmacyId=${pharmacyA._id}&barcode=8901234567890`,
    tokenA
  );
  assert.equal(lookupRes.status, 200);
  assert.equal(lookupRes.body.length, 1);
  assert.equal(lookupRes.body[0].drug, 'Cetirizine');

  // 4. Couriers list for pharmacy
  const couriersRes = await call('GET', `/api/pharmacy/couriers?pharmacyId=${pharmacyA._id}`, tokenA);
  assert.equal(couriersRes.status, 200);
  assert.equal(couriersRes.body.length, 1);
  assert.equal(couriersRes.body[0]._id, String(courierA._id));
  assert.equal(couriersRes.body[0].passwordHash, undefined);
});
