// MediCluster Pharmacy Suite — Order State Machine & Transition Rules
// Based on Native Pharmacy Suite Design Spec sections 4.2 & 4.3

export const ORDER_STATUS = {
  NEW: 'new',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

export const DELIVERY_STATUS = {
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  FAILED: 'failed',
};

export const STATUS_LABELS = {
  new: 'New Order',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready for Handover',
  out_for_delivery: 'Out for Delivery',
  picked_up: 'Picked Up',
  delivered: 'Delivered',
  delivery_failed: 'Delivery Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const STATUS_BADGES = {
  new: 'rx-badge-blue',
  accepted: 'rx-badge-amber',
  preparing: 'rx-badge-amber',
  ready: 'rx-badge-emerald',
  out_for_delivery: 'rx-badge-purple',
  picked_up: 'rx-badge-teal',
  delivered: 'rx-badge-green',
  delivery_failed: 'rx-badge-rose',
  rejected: 'rx-badge-rose',
  cancelled: 'rx-badge-gray',
};

export const FULFILMENT_TYPES = {
  PICKUP: 'pickup',
  DELIVERY: 'delivery',
};

/**
 * Returns whether an order status is terminal.
 */
export function isTerminalStatus(status) {
  return ['picked_up', 'delivered', 'rejected', 'cancelled'].includes(status);
}

/**
 * Calculates allowed actions for a given order and actor role.
 * Role can be 'pharmacist', 'courier', or 'patient'.
 */
export function getAllowedActions(order, role = 'pharmacist') {
  if (!order || !order.status) return [];
  const status = order.status;
  const fulfilment = order.fulfilment || 'pickup';
  const deliveryStatus = order.delivery?.status;

  if (role === 'pharmacist') {
    switch (status) {
      case ORDER_STATUS.NEW:
        return [
          { action: 'accept', label: 'Accept Order', variant: 'primary' },
          { action: 'reject', label: 'Reject Order', variant: 'danger', requiresReason: true },
          { action: 'cancel', label: 'Cancel', variant: 'secondary' },
        ];
      case ORDER_STATUS.ACCEPTED:
        return [
          { action: 'start', label: 'Start Preparing', variant: 'primary' },
          { action: 'cancel', label: 'Cancel', variant: 'secondary' },
        ];
      case ORDER_STATUS.PREPARING:
        return [
          { action: 'ready', label: 'Mark Ready', variant: 'primary' },
          { action: 'cancel', label: 'Cancel', variant: 'secondary' },
        ];
      case ORDER_STATUS.READY:
        if (fulfilment === FULFILMENT_TYPES.PICKUP) {
          return [
            { action: 'handover', label: 'Handover to Patient', variant: 'primary', requiresOtp: true },
          ];
        }
        if (fulfilment === FULFILMENT_TYPES.DELIVERY) {
          if (!order.courierId) {
            return [
              { action: 'assign_courier', label: 'Assign Courier', variant: 'primary', requiresCourier: true },
            ];
          }
          return [
            { action: 'assign_courier', label: 'Reassign Courier', variant: 'secondary', requiresCourier: true },
          ];
        }
        return [];
      case ORDER_STATUS.DELIVERY_FAILED:
        return [
          { action: 'assign_courier', label: 'Reassign Courier', variant: 'primary', requiresCourier: true },
        ];
      default:
        return [];
    }
  }

  if (role === 'courier') {
    // If order has a delivery sub-record or delivery status
    if (status === ORDER_STATUS.READY && fulfilment === FULFILMENT_TYPES.DELIVERY) {
      if (deliveryStatus === DELIVERY_STATUS.ASSIGNED || !deliveryStatus) {
        return [
          { action: 'accept', label: 'Accept Delivery', variant: 'primary' },
        ];
      }
      if (deliveryStatus === DELIVERY_STATUS.ACCEPTED) {
        return [
          { action: 'pickup', label: 'Confirm Pharmacy Pickup', variant: 'primary' },
        ];
      }
    }

    if (status === ORDER_STATUS.OUT_FOR_DELIVERY) {
      return [
        { action: 'deliver', label: 'Complete Delivery', variant: 'primary', requiresOtp: true },
        { action: 'fail', label: 'Report Delivery Failure', variant: 'danger', requiresReason: true },
      ];
    }

    return [];
  }

  if (role === 'patient') {
    if ([ORDER_STATUS.NEW, ORDER_STATUS.ACCEPTED, ORDER_STATUS.PREPARING].includes(status)) {
      return [
        { action: 'cancel', label: 'Cancel Order', variant: 'secondary' },
      ];
    }
    return [];
  }

  return [];
}

/**
 * Pure transition validator matching spec section 4.3.
 */
export function validateTransition(order, action, actorRole) {
  const status = order?.status;
  const fulfilment = order?.fulfilment || 'pickup';

  if (actorRole === 'pharmacist') {
    if (action === 'accept' && status === ORDER_STATUS.NEW) {
      return { ok: true, nextStatus: ORDER_STATUS.ACCEPTED };
    }
    if (action === 'reject' && status === ORDER_STATUS.NEW) {
      return { ok: true, nextStatus: ORDER_STATUS.REJECTED };
    }
    if (action === 'start' && status === ORDER_STATUS.ACCEPTED) {
      return { ok: true, nextStatus: ORDER_STATUS.PREPARING };
    }
    if (action === 'ready' && status === ORDER_STATUS.PREPARING) {
      return { ok: true, nextStatus: ORDER_STATUS.READY };
    }
    if (action === 'handover' && status === ORDER_STATUS.READY && fulfilment === FULFILMENT_TYPES.PICKUP) {
      return { ok: true, nextStatus: ORDER_STATUS.PICKED_UP };
    }
    if (action === 'assign_courier' && (status === ORDER_STATUS.READY || status === ORDER_STATUS.DELIVERY_FAILED) && fulfilment === FULFILMENT_TYPES.DELIVERY) {
      return { ok: true, nextStatus: ORDER_STATUS.READY };
    }
    if (action === 'cancel' && [ORDER_STATUS.NEW, ORDER_STATUS.ACCEPTED, ORDER_STATUS.PREPARING].includes(status)) {
      return { ok: true, nextStatus: ORDER_STATUS.CANCELLED };
    }
  }

  if (actorRole === 'courier') {
    if (action === 'accept' && status === ORDER_STATUS.READY) {
      return { ok: true, nextStatus: ORDER_STATUS.READY, nextDeliveryStatus: DELIVERY_STATUS.ACCEPTED };
    }
    if (action === 'pickup' && status === ORDER_STATUS.READY) {
      return { ok: true, nextStatus: ORDER_STATUS.OUT_FOR_DELIVERY, nextDeliveryStatus: DELIVERY_STATUS.PICKED_UP };
    }
    if (action === 'deliver' && status === ORDER_STATUS.OUT_FOR_DELIVERY) {
      return { ok: true, nextStatus: ORDER_STATUS.DELIVERED, nextDeliveryStatus: DELIVERY_STATUS.DELIVERED };
    }
    if (action === 'fail' && status === ORDER_STATUS.OUT_FOR_DELIVERY) {
      return { ok: true, nextStatus: ORDER_STATUS.DELIVERY_FAILED, nextDeliveryStatus: DELIVERY_STATUS.FAILED };
    }
  }

  if (actorRole === 'patient') {
    if (action === 'cancel' && [ORDER_STATUS.NEW, ORDER_STATUS.ACCEPTED, ORDER_STATUS.PREPARING].includes(status)) {
      return { ok: true, nextStatus: ORDER_STATUS.CANCELLED };
    }
  }

  return { ok: false, error: `Invalid transition '${action}' from status '${status}' for role '${actorRole}'` };
}
