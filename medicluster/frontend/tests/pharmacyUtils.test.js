import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_DESCRIPTIONS,
  PICKUP_STEPS,
  DELIVERY_STEPS,
  shouldShowCourierLocation,
  shouldShowHandoverOtp,
  sanitizeOrderForPatient,
  getOrderTimeline,
} from '../src/pharmacy/pharmacyOrderUtils.js';

test('timeline and state labels cover all standard and terminal order states', () => {
  const expectedStatuses = [
    'new',
    'accepted',
    'preparing',
    'ready',
    'out_for_delivery',
    'delivered',
    'picked_up',
    'rejected',
    'cancelled',
    'delivery_failed',
  ];

  for (const status of expectedStatuses) {
    assert.ok(ORDER_STATUS_LABELS[status], `Missing label for status: ${status}`);
    assert.ok(ORDER_STATUS_DESCRIPTIONS[status], `Missing description for status: ${status}`);
  }

  assert.equal(ORDER_STATUS_LABELS.new, 'Order Placed');
  assert.equal(ORDER_STATUS_LABELS.out_for_delivery, 'Out for Delivery');
  assert.equal(ORDER_STATUS_LABELS.delivered, 'Delivered');
  assert.equal(ORDER_STATUS_LABELS.picked_up, 'Picked Up');
});

test('order timeline constructs steps correctly for pickup and delivery', () => {
  // 1. Delivery order in 'preparing'
  const deliveryOrder = {
    _id: 'ord-1',
    fulfilment: 'delivery',
    status: 'preparing',
    createdAt: '2026-11-12T10:00:00Z',
    statusHistory: [
      { status: 'new', at: '2026-11-12T10:00:00Z' },
      { status: 'accepted', at: '2026-11-12T10:05:00Z' },
      { status: 'preparing', at: '2026-11-12T10:15:00Z' },
    ],
  };

  const deliveryTimeline = getOrderTimeline(deliveryOrder);
  assert.equal(deliveryTimeline.length, DELIVERY_STEPS.length);
  assert.deepEqual(deliveryTimeline.map(s => s.key), DELIVERY_STEPS);

  // new and accepted should be completed; preparing active; ready, out_for_delivery, delivered pending
  assert.equal(deliveryTimeline[0].completed, true);
  assert.equal(deliveryTimeline[1].completed, true);
  assert.equal(deliveryTimeline[2].active, true);
  assert.equal(deliveryTimeline[3].completed, false);
  assert.equal(deliveryTimeline[3].active, false);

  // 2. Pickup order in 'ready'
  const pickupOrder = {
    _id: 'ord-2',
    fulfilment: 'pickup',
    status: 'ready',
    createdAt: '2026-11-12T10:00:00Z',
    statusHistory: [
      { status: 'new', at: '2026-11-12T10:00:00Z' },
      { status: 'accepted', at: '2026-11-12T10:05:00Z' },
      { status: 'preparing', at: '2026-11-12T10:10:00Z' },
      { status: 'ready', at: '2026-11-12T10:20:00Z' },
    ],
  };

  const pickupTimeline = getOrderTimeline(pickupOrder);
  assert.equal(pickupTimeline.length, PICKUP_STEPS.length);
  assert.deepEqual(pickupTimeline.map(s => s.key), PICKUP_STEPS);
  assert.equal(pickupTimeline[3].key, 'ready');
  assert.equal(pickupTimeline[3].active, true);
  assert.equal(pickupTimeline[4].key, 'picked_up');
  assert.equal(pickupTimeline[4].active, false);
});

test('privacy rule: courier location is visible ONLY while out_for_delivery and NEVER after delivered', () => {
  // Rule verification
  assert.equal(shouldShowCourierLocation('out_for_delivery'), true);
  assert.equal(shouldShowCourierLocation('delivered'), false, 'Courier location must not be shown after delivered');
  assert.equal(shouldShowCourierLocation('picked_up'), false);
  assert.equal(shouldShowCourierLocation('ready'), false);
  assert.equal(shouldShowCourierLocation('preparing'), false);
  assert.equal(shouldShowCourierLocation('new'), false);
  assert.equal(shouldShowCourierLocation('cancelled'), false);

  const mockLocation = { lat: 12.9716, lng: 77.5946, accuracy: 5, observedAt: '2026-11-12T10:30:00Z' };

  // When order is out_for_delivery, location is retained
  const activeDelivery = {
    _id: 'ord-3',
    status: 'out_for_delivery',
    courierLocation: mockLocation,
    delivery: { courierId: 'cour-1', lastLocation: mockLocation },
    handoverOtp: '4821',
  };

  const sanitizedActive = sanitizeOrderForPatient(activeDelivery);
  assert.deepEqual(sanitizedActive.courierLocation, mockLocation);
  assert.deepEqual(sanitizedActive.delivery.lastLocation, mockLocation);
  assert.equal(sanitizedActive.handoverOtp, '4821');

  // When order is DELIVERED, courier location is strictly sanitized/hidden
  const deliveredOrder = {
    _id: 'ord-3',
    status: 'delivered',
    courierLocation: mockLocation,
    delivery: { courierId: 'cour-1', lastLocation: mockLocation },
    handoverOtp: '4821',
  };

  const sanitizedDelivered = sanitizeOrderForPatient(deliveredOrder);
  assert.equal(sanitizedDelivered.courierLocation, null, 'courierLocation must be scrubbed after delivery');
  assert.equal(sanitizedDelivered.delivery.lastLocation, null, 'delivery.lastLocation must be scrubbed after delivery');
  assert.equal(sanitizedDelivered.handoverOtp, null, 'handoverOtp must be scrubbed after delivery');
});

test('privacy rule: handover OTP is visible only when ready or out_for_delivery', () => {
  assert.equal(shouldShowHandoverOtp('ready'), true);
  assert.equal(shouldShowHandoverOtp('out_for_delivery'), true);
  assert.equal(shouldShowHandoverOtp('new'), false);
  assert.equal(shouldShowHandoverOtp('accepted'), false);
  assert.equal(shouldShowHandoverOtp('preparing'), false);
  assert.equal(shouldShowHandoverOtp('delivered'), false);
  assert.equal(shouldShowHandoverOtp('picked_up'), false);

  const preparingOrder = {
    _id: 'ord-4',
    status: 'preparing',
    handoverOtp: '9999',
  };
  const sanitizedPreparing = sanitizeOrderForPatient(preparingOrder);
  assert.equal(sanitizedPreparing.handoverOtp, null, 'handoverOtp must be hidden while preparing');
});
