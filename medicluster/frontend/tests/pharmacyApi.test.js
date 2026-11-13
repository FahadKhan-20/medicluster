import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS,
  DELIVERY_STATUS,
  getAllowedActions,
  validateTransition,
  isTerminalStatus,
} from '../src/pharmacy/orderStateMachine.js';
import {
  setPharmacistSession,
  getPharmacistToken,
  getPharmacistStaff,
  clearPharmacistSession,
  setCourierSession,
  getCourierToken,
  getCourierStaff,
  clearCourierSession,
  PHARMACY_TOKEN_KEY,
  COURIER_TOKEN_KEY,
} from '../src/pharmacy/session.js';
import {
  loginPharmacist,
  getPharmacyOrders,
  getPharmacyOrder,
  executeOrderAction,
  getPharmacyStock,
  loginCourier,
  getCourierDeliveries,
  getCourierDelivery,
  executeCourierAction,
  sendCourierLocation,
  ApiError,
} from '../src/pharmacy/api.js';

// Polyfill localStorage if running in bare Node test runner
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

test('orderStateMachine: pharmacist allowed actions across all order states', () => {
  // New order
  const newOrder = { status: ORDER_STATUS.NEW, fulfilment: 'pickup' };
  const newActions = getAllowedActions(newOrder, 'pharmacist');
  assert.deepEqual(newActions.map(a => a.action), ['accept', 'reject', 'cancel']);
  assert.equal(newActions.find(a => a.action === 'reject').requiresReason, true);

  // Accepted order
  const acceptedOrder = { status: ORDER_STATUS.ACCEPTED, fulfilment: 'pickup' };
  const acceptedActions = getAllowedActions(acceptedOrder, 'pharmacist');
  assert.deepEqual(acceptedActions.map(a => a.action), ['start', 'cancel']);

  // Preparing order
  const preparingOrder = { status: ORDER_STATUS.PREPARING, fulfilment: 'pickup' };
  const preparingActions = getAllowedActions(preparingOrder, 'pharmacist');
  assert.deepEqual(preparingActions.map(a => a.action), ['ready', 'cancel']);

  // Ready pickup order
  const readyPickup = { status: ORDER_STATUS.READY, fulfilment: 'pickup' };
  const readyPickupActions = getAllowedActions(readyPickup, 'pharmacist');
  assert.deepEqual(readyPickupActions.map(a => a.action), ['handover']);
  assert.equal(readyPickupActions[0].requiresOtp, true);

  // Ready delivery order (no courier assigned)
  const readyDelivery = { status: ORDER_STATUS.READY, fulfilment: 'delivery' };
  const readyDeliveryActions = getAllowedActions(readyDelivery, 'pharmacist');
  assert.deepEqual(readyDeliveryActions.map(a => a.action), ['assign_courier']);
  assert.equal(readyDeliveryActions[0].requiresCourier, true);

  // Ready delivery order (courier already assigned)
  const readyWithCourier = { status: ORDER_STATUS.READY, fulfilment: 'delivery', courierId: 'c-1' };
  const readyCourierActions = getAllowedActions(readyWithCourier, 'pharmacist');
  assert.deepEqual(readyCourierActions.map(a => a.action), ['assign_courier']);
  assert.equal(readyCourierActions[0].label, 'Reassign Courier');

  // Terminal orders
  assert.deepEqual(getAllowedActions({ status: ORDER_STATUS.PICKED_UP }, 'pharmacist'), []);
  assert.deepEqual(getAllowedActions({ status: ORDER_STATUS.DELIVERED }, 'pharmacist'), []);
  assert.deepEqual(getAllowedActions({ status: ORDER_STATUS.REJECTED }, 'pharmacist'), []);
  assert.deepEqual(getAllowedActions({ status: ORDER_STATUS.CANCELLED }, 'pharmacist'), []);

  assert.equal(isTerminalStatus('delivered'), true);
  assert.equal(isTerminalStatus('picked_up'), true);
  assert.equal(isTerminalStatus('preparing'), false);
});

test('orderStateMachine: courier allowed actions across delivery lifecycles', () => {
  // Assigned delivery
  const assigned = {
    status: ORDER_STATUS.READY,
    fulfilment: 'delivery',
    delivery: { status: DELIVERY_STATUS.ASSIGNED },
  };
  const assignedActions = getAllowedActions(assigned, 'courier');
  assert.deepEqual(assignedActions.map(a => a.action), ['accept']);

  // Accepted delivery at pharmacy
  const accepted = {
    status: ORDER_STATUS.READY,
    fulfilment: 'delivery',
    delivery: { status: DELIVERY_STATUS.ACCEPTED },
  };
  const acceptedActions = getAllowedActions(accepted, 'courier');
  assert.deepEqual(acceptedActions.map(a => a.action), ['pickup']);

  // Out for delivery
  const inTransit = {
    status: ORDER_STATUS.OUT_FOR_DELIVERY,
    fulfilment: 'delivery',
    delivery: { status: DELIVERY_STATUS.PICKED_UP },
  };
  const inTransitActions = getAllowedActions(inTransit, 'courier');
  assert.deepEqual(inTransitActions.map(a => a.action), ['deliver', 'fail']);
  assert.equal(inTransitActions.find(a => a.action === 'deliver').requiresOtp, true);
  assert.equal(inTransitActions.find(a => a.action === 'fail').requiresReason, true);

  // Delivered
  const delivered = {
    status: ORDER_STATUS.DELIVERED,
    delivery: { status: DELIVERY_STATUS.DELIVERED },
  };
  assert.deepEqual(getAllowedActions(delivered, 'courier'), []);
});

test('orderStateMachine: transition validator enforces allowed and forbidden state changes', () => {
  // Valid transitions
  assert.equal(validateTransition({ status: 'new' }, 'accept', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'new' }, 'reject', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'accepted' }, 'start', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'preparing' }, 'ready', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'ready', fulfilment: 'pickup' }, 'handover', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'ready', fulfilment: 'delivery' }, 'assign_courier', 'pharmacist').ok, true);
  assert.equal(validateTransition({ status: 'ready' }, 'pickup', 'courier').ok, true);
  assert.equal(validateTransition({ status: 'out_for_delivery' }, 'deliver', 'courier').ok, true);
  assert.equal(validateTransition({ status: 'out_for_delivery' }, 'fail', 'courier').ok, true);

  // Invalid forbidden transitions
  assert.equal(validateTransition({ status: 'new' }, 'ready', 'pharmacist').ok, false);
  assert.equal(validateTransition({ status: 'ready', fulfilment: 'delivery' }, 'handover', 'pharmacist').ok, false);
  assert.equal(validateTransition({ status: 'out_for_delivery' }, 'accept', 'courier').ok, false);
  assert.equal(validateTransition({ status: 'new' }, 'deliver', 'courier').ok, false);
});

test('session: pharmacist and courier tokens are stored separately and isolated from clinician sessions', () => {
  localStorage.clear();

  // Set clinician token
  localStorage.setItem('medicluster.token', 'clinician-jwt-token');

  // Set pharmacist session
  setPharmacistSession({
    token: 'pharmacy-jwt-token',
    staff: { id: 'pharm-1', name: 'Pharmacist Rao', role: 'pharmacist', pharmacyIds: ['ph-blr-1'] },
    pharmacies: [{ id: 'ph-blr-1', name: 'Apollo Indiranagar' }],
  });

  // Set courier session
  setCourierSession({
    token: 'courier-jwt-token',
    staff: { id: 'cour-1', name: 'Ravi Driver', role: 'courier' },
  });

  // Verify separation
  assert.equal(localStorage.getItem('medicluster.token'), 'clinician-jwt-token');
  assert.equal(getPharmacistToken(), 'pharmacy-jwt-token');
  assert.equal(getCourierToken(), 'courier-jwt-token');
  assert.equal(getPharmacistStaff()?.name, 'Pharmacist Rao');
  assert.equal(getCourierStaff()?.name, 'Ravi Driver');

  // Clearing pharmacist session leaves courier and clinician tokens untouched
  clearPharmacistSession();
  assert.equal(getPharmacistToken(), null);
  assert.equal(getPharmacistStaff(), null);
  assert.equal(getCourierToken(), 'courier-jwt-token');
  assert.equal(localStorage.getItem('medicluster.token'), 'clinician-jwt-token');

  // Clearing courier session leaves clinician token untouched
  clearCourierSession();
  assert.equal(getCourierToken(), null);
  assert.equal(localStorage.getItem('medicluster.token'), 'clinician-jwt-token');
});

test('api: pharmacist requests use pharmacist token, format query params, and handle 401/409', async () => {
  localStorage.clear();
  setPharmacistSession({
    token: 'test-pharm-bearer',
    staff: { id: 'p-1', name: 'Test Pharmacist' },
    pharmacies: [{ id: 'ph-1', name: 'Main Pharmacy' }],
  });

  const capturedCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    capturedCalls.push({ url: String(url), options });

    if (String(url).includes('/api/pharmacy-auth/login')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ token: 'new-pharm-token', staff: { id: 'p-2' }, pharmacies: [{ id: 'ph-2' }] }),
      };
    }

    if (String(url).includes('/api/pharmacy/orders/ord-409/actions')) {
      return {
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Order was already accepted by another pharmacist' }),
      };
    }

    if (String(url).includes('/api/pharmacy/orders/ord-401')) {
      return {
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Token expired' }),
      };
    }

    if (String(url).includes('/api/pharmacy/orders')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => [{ id: 'ord-1', status: 'new' }],
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
    };
  };

  try {
    // 1. getPharmacyOrders formats params and sends Bearer token
    const orders = await getPharmacyOrders({ pharmacyId: 'ph-1', status: 'new' });
    assert.equal(orders.length, 1);
    assert.equal(capturedCalls[0].url, '/api/pharmacy/orders?pharmacyId=ph-1&status=new');
    assert.equal(capturedCalls[0].options.headers.Authorization, 'Bearer test-pharm-bearer');

    // 2. 409 Conflict triggers isConflict and descriptive message
    await assert.rejects(
      async () => executeOrderAction('ord-409', { action: 'accept' }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.isConflict, true);
        assert.match(err.message, /already accepted/i);
        return true;
      }
    );

    // 3. 401 Unauthorized clears token and sets isUnauthorized
    await assert.rejects(
      async () => getPharmacyOrder('ord-401'),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.isUnauthorized, true);
        assert.equal(getPharmacistToken(), null);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('api: courier requests use courier token, send live location and execute actions', async () => {
  localStorage.clear();
  setCourierSession({
    token: 'test-courier-bearer',
    staff: { id: 'c-1', name: 'Courier Rider' },
  });

  const capturedCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    capturedCalls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
    };
  };

  try {
    // 1. sendCourierLocation
    await sendCourierLocation('del-1', { lat: 12.9716, lng: 77.5946, accuracy: 8 });
    assert.equal(capturedCalls[0].url, '/api/courier/deliveries/del-1/location');
    assert.equal(capturedCalls[0].options.headers.Authorization, 'Bearer test-courier-bearer');
    assert.equal(capturedCalls[0].body.lat, 12.9716);
    assert.equal(capturedCalls[0].body.lng, 77.5946);
    assert.equal(capturedCalls[0].body.accuracy, 8);
    assert.ok(capturedCalls[0].body.observedAt);

    // 2. executeCourierAction handover with OTP
    await executeCourierAction('del-1', { action: 'deliver', otp: '4321', note: 'Handed to patient' });
    assert.equal(capturedCalls[1].url, '/api/courier/deliveries/del-1/actions');
    assert.equal(capturedCalls[1].body.action, 'deliver');
    assert.equal(capturedCalls[1].body.otp, '4321');
    assert.equal(capturedCalls[1].body.note, 'Handed to patient');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
