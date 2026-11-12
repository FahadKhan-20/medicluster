const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ORDER_STATUSES,
  transition,
  hashOtp,
  otpMatches,
} = require('../services/pharmacyOrders');

const sampleOrder = (overrides = {}) => ({
  _id: 'ord-123',
  patientId: 'patient-1',
  pharmacyId: 'pharma-1',
  source: { type: 'prescription', prescriptionId: 'rx-1' },
  items: [{ drug: 'Amoxicillin', quantity: 1 }],
  fulfilment: 'pickup',
  status: 'new',
  statusHistory: [],
  ...overrides,
});

test('OTP hashing and timing-safe matching', () => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long';
  const hashed = hashOtp('1234');
  assert.equal(typeof hashed, 'string');
  assert.equal(hashed.length, 64);
  assert.equal(otpMatches('1234', hashed), true);
  assert.equal(otpMatches('9999', hashed), false);
  assert.equal(otpMatches('', hashed), false);
  assert.equal(otpMatches('1234', ''), false);
});

test('table-driven walk of spec 4.3 valid transitions', () => {
  const transitions = [
    {
      action: 'accept',
      from: 'new',
      to: 'accepted',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'new' }),
    },
    {
      action: 'reject',
      from: 'new',
      to: 'rejected',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'new' }),
      input: { reason: 'Out of stock' },
    },
    {
      action: 'start',
      from: 'accepted',
      to: 'preparing',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'accepted' }),
    },
    {
      action: 'ready',
      from: 'preparing',
      to: 'ready',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'preparing' }),
    },
    {
      action: 'handover',
      from: 'ready',
      to: 'picked_up',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'ready', fulfilment: 'pickup' }),
      input: { otp: '4321' },
    },
    {
      action: 'assign_courier',
      from: 'ready',
      to: 'ready',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'ready', fulfilment: 'delivery' }),
      input: { courierId: 'c1' },
    },
    {
      action: 'courier_pickup',
      from: 'ready',
      to: 'out_for_delivery',
      actor: { kind: 'courier', id: 'c1' },
      order: sampleOrder({ status: 'ready', fulfilment: 'delivery', courierId: 'c1' }),
    },
    {
      action: 'deliver',
      from: 'out_for_delivery',
      to: 'delivered',
      actor: { kind: 'courier', id: 'c1' },
      order: sampleOrder({ status: 'out_for_delivery', fulfilment: 'delivery', courierId: 'c1' }),
      input: { otp: '4321' },
    },
    {
      action: 'fail',
      from: 'out_for_delivery',
      to: 'delivery_failed',
      actor: { kind: 'courier', id: 'c1' },
      order: sampleOrder({ status: 'out_for_delivery', fulfilment: 'delivery', courierId: 'c1' }),
      input: { reason: 'Address not found' },
    },
    {
      action: 'cancel',
      from: 'new',
      to: 'cancelled',
      actor: { kind: 'patient', id: 'patient-1' },
      order: sampleOrder({ status: 'new' }),
    },
    {
      action: 'cancel',
      from: 'accepted',
      to: 'cancelled',
      actor: { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] },
      order: sampleOrder({ status: 'accepted' }),
    },
    {
      action: 'cancel',
      from: 'preparing',
      to: 'cancelled',
      actor: { kind: 'patient', id: 'patient-1' },
      order: sampleOrder({ status: 'preparing' }),
    },
  ];

  for (const step of transitions) {
    const result = transition(step.order, step.action, step.actor, step.input);
    assert.equal(result.order.status, step.to, `${step.action} from ${step.from} should be ${step.to}`);
    assert.ok(Array.isArray(result.effects));
    assert.equal(result.order.statusHistory.at(-1)?.status, step.to);
  }
});

test('every action from a status not listed for it throws 409', () => {
  const allowed = {
    accept: ['new'],
    reject: ['new'],
    start: ['accepted'],
    ready: ['preparing'],
    handover: ['ready'],
    assign_courier: ['ready', 'delivery_failed'],
    courier_pickup: ['ready'],
    deliver: ['out_for_delivery'],
    fail: ['out_for_delivery'],
    cancel: ['new', 'accepted', 'preparing'],
  };

  const actorFor = action => {
    if (['courier_pickup', 'deliver', 'fail'].includes(action)) {
      return { kind: 'courier', id: 'c1' };
    }
    return { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  };

  for (const [action, validStatuses] of Object.entries(allowed)) {
    for (const status of ORDER_STATUSES) {
      if (!validStatuses.includes(status)) {
        const order = sampleOrder({
          status,
          fulfilment: 'delivery',
          courierId: 'c1',
        });
        assert.throws(
          () => transition(order, action, actorFor(action), { reason: 'test', otp: '1234', courierId: 'c1' }),
          err => err.status === 409,
          `Expected 409 for ${action} from ${status}`
        );
      }
    }
  }
});

test('pharmacist of another pharmacy throws 403', () => {
  const order = sampleOrder({ status: 'new', pharmacyId: 'pharma-1' });
  const actor = { kind: 'pharmacy', id: 's2', pharmacyIds: ['other-pharma'] };
  assert.throws(
    () => transition(order, 'accept', actor),
    err => err.status === 403
  );
});

test('courier who is not order.courierId throws 403', () => {
  const orderPickup = sampleOrder({ status: 'ready', fulfilment: 'delivery', courierId: 'c1' });
  const otherCourier = { kind: 'courier', id: 'c2' };
  assert.throws(
    () => transition(orderPickup, 'courier_pickup', otherCourier),
    err => err.status === 403
  );

  const orderOut = sampleOrder({ status: 'out_for_delivery', fulfilment: 'delivery', courierId: 'c1' });
  assert.throws(
    () => transition(orderOut, 'deliver', otherCourier, { otp: '1234' }),
    err => err.status === 403
  );
  assert.throws(
    () => transition(orderOut, 'fail', otherCourier, { reason: 'problem' }),
    err => err.status === 403
  );
});

test('ready emits generate_otp and decrement_stock', () => {
  const order = sampleOrder({ status: 'preparing', items: [{ drug: 'Paracetamol', quantity: 2 }] });
  const actor = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  const res = transition(order, 'ready', actor);
  assert.equal(res.order.status, 'ready');
  assert.deepEqual(res.effects, [
    { type: 'generate_otp' },
    { type: 'decrement_stock', items: [{ drug: 'Paracetamol', quantity: 2 }] },
  ]);
});

test('assign_courier emits create_delivery and requires fulfilment === "delivery"', () => {
  const actor = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };

  const pickupOrder = sampleOrder({ status: 'ready', fulfilment: 'pickup' });
  assert.throws(
    () => transition(pickupOrder, 'assign_courier', actor, { courierId: 'c1' }),
    err => err.status === 409
  );

  const deliveryOrder = sampleOrder({ status: 'ready', fulfilment: 'delivery' });
  const res = transition(deliveryOrder, 'assign_courier', actor, { courierId: 'c1' });
  assert.equal(res.order.status, 'ready');
  assert.equal(res.order.courierId, 'c1');
  assert.deepEqual(res.effects, [{ type: 'create_delivery', courierId: 'c1' }]);
});

test('handover and deliver without otp throw 400', () => {
  const actorPharm = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  const orderPickup = sampleOrder({ status: 'ready', fulfilment: 'pickup' });
  assert.throws(
    () => transition(orderPickup, 'handover', actorPharm, {}),
    err => err.status === 400
  );

  const actorCourier = { kind: 'courier', id: 'c1' };
  const orderOut = sampleOrder({ status: 'out_for_delivery', fulfilment: 'delivery', courierId: 'c1' });
  assert.throws(
    () => transition(orderOut, 'deliver', actorCourier, {}),
    err => err.status === 400
  );

  // deliver with photoMediaId succeeds
  const photoDeliver = transition(orderOut, 'deliver', actorCourier, { photoMediaId: 'media-9' });
  assert.equal(photoDeliver.order.status, 'delivered');
  assert.deepEqual(photoDeliver.effects, [
    { type: 'close_delivery', status: 'delivered', photoMediaId: 'media-9' },
  ]);
});

test('reject without reason throws 400', () => {
  const order = sampleOrder({ status: 'new' });
  const actor = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  assert.throws(
    () => transition(order, 'reject', actor, {}),
    err => err.status === 400
  );
});

test('accept twice: second call on the returned order throws 409', () => {
  const order = sampleOrder({ status: 'new' });
  const actor = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  const first = transition(order, 'accept', actor);
  assert.equal(first.order.status, 'accepted');
  assert.throws(
    () => transition(first.order, 'accept', actor),
    err => err.status === 409
  );
  assert.equal(first.order.statusHistory.filter(h => h.status === 'accepted').length, 1);
});

test('input order object is not mutated', () => {
  const order = sampleOrder({ status: 'new', statusHistory: [] });
  const clone = JSON.parse(JSON.stringify(order));
  const actor = { kind: 'pharmacy', id: 's1', pharmacyIds: ['pharma-1'] };
  transition(order, 'accept', actor);
  assert.deepEqual(order, clone);
});
