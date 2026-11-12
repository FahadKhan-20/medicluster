/**
 * src/pharmacy/pharmacyOrderUtils.js
 * Pure utilities for pharmacy order states, timeline construction,
 * and privacy rule enforcement (spec 4.3 & 4.5).
 */

export const ORDER_STATUS_LABELS = {
  new: "Order Placed",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  picked_up: "Picked Up",
  rejected: "Rejected",
  cancelled: "Cancelled",
  delivery_failed: "Delivery Failed",
};

export const ORDER_STATUS_DESCRIPTIONS = {
  new: "Your order has been received and is waiting for pharmacy review.",
  accepted: "The pharmacy has confirmed and accepted your order.",
  preparing: "Your prescription items are being prepared and verified.",
  ready: "Your medications are packaged and ready.",
  out_for_delivery: "Courier is en route with your delivery.",
  delivered: "Medications have been delivered to your destination.",
  picked_up: "Medications were handed over at the pharmacy counter.",
  rejected: "The pharmacy was unable to fulfill this order.",
  cancelled: "Order has been cancelled.",
  delivery_failed: "Delivery attempt was unsuccessful. Pharmacy is reassessing.",
};

export const PICKUP_STEPS = ["new", "accepted", "preparing", "ready", "picked_up"];
export const DELIVERY_STEPS = ["new", "accepted", "preparing", "ready", "out_for_delivery", "delivered"];

/**
 * Spec 4.5: The patient sees courier location only while their order is out_for_delivery.
 * Courier location is strictly hidden once delivered, picked up, or when in any other status.
 */
export function shouldShowCourierLocation(status) {
  return String(status || "").toLowerCase() === "out_for_delivery";
}

/**
 * Handover OTP is 4 digits generated on ready and shown to the patient
 * when the order is ready for pickup or out for delivery.
 */
export function shouldShowHandoverOtp(status) {
  const s = String(status || "").toLowerCase();
  return s === "ready" || s === "out_for_delivery";
}

/**
 * Sanitizes an order object for patient consumption according to spec 4.5.
 * Courier location is scrubbed if status is not 'out_for_delivery'.
 */
export function sanitizeOrderForPatient(order) {
  if (!order || typeof order !== "object") return order;
  const sanitized = { ...order };
  const canSeeCourier = shouldShowCourierLocation(sanitized.status);

  if (!canSeeCourier) {
    if ("courierLocation" in sanitized) sanitized.courierLocation = null;
    if (sanitized.delivery && typeof sanitized.delivery === "object") {
      sanitized.delivery = { ...sanitized.delivery, lastLocation: null };
    }
    if (sanitized.lastLocation) sanitized.lastLocation = null;
  }

  // Ensure handoverOtp is only visible when ready or out_for_delivery
  if (!shouldShowHandoverOtp(sanitized.status)) {
    sanitized.handoverOtp = null;
  }

  return sanitized;
}

/**
 * Constructs a step-by-step progress timeline for the order.
 */
export function getOrderTimeline(order) {
  if (!order) return [];
  const fulfilment = order.fulfilment === "delivery" ? "delivery" : "pickup";
  const expectedSteps = fulfilment === "delivery" ? DELIVERY_STEPS : PICKUP_STEPS;
  const currentStatus = String(order.status || "new").toLowerCase();

  // If rejected or cancelled or failed, handle abnormal termination
  const isTerminalFailure = ["rejected", "cancelled", "delivery_failed"].includes(currentStatus);
  const statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const historyMap = new Map();
  for (const h of statusHistory) {
    if (h && h.status) historyMap.set(h.status.toLowerCase(), h);
  }

  const currentIndex = expectedSteps.indexOf(currentStatus);

  const steps = expectedSteps.map((stepKey, idx) => {
    const label = ORDER_STATUS_LABELS[stepKey] || stepKey;
    const historyEntry = historyMap.get(stepKey);
    const at = historyEntry ? historyEntry.at : (stepKey === "new" ? order.createdAt : null);

    let completed = false;
    let active = false;

    if (!isTerminalFailure) {
      if (currentIndex >= 0) {
        completed = idx < currentIndex;
        active = idx === currentIndex;
      }
    } else {
      // Find how far it got before failure
      if (historyMap.has(stepKey)) {
        completed = true;
      }
    }

    return {
      key: stepKey,
      label,
      description: ORDER_STATUS_DESCRIPTIONS[stepKey] || "",
      completed,
      active,
      at,
    };
  });

  if (isTerminalFailure) {
    const failEntry = historyMap.get(currentStatus);
    steps.push({
      key: currentStatus,
      label: ORDER_STATUS_LABELS[currentStatus] || currentStatus,
      description: order.rejectReason || ORDER_STATUS_DESCRIPTIONS[currentStatus] || "",
      completed: false,
      active: true,
      failed: true,
      at: failEntry ? failEntry.at : order.updatedAt || null,
    });
  }

  return steps;
}
