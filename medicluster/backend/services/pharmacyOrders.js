/**
 * backend/services/pharmacyOrders.js
 * Pure state-machine and OTP verification for pharmacy orders.
 */

const crypto = require("node:crypto");

const ORDER_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "rejected",
  "cancelled",
];

function secret() {
  return process.env.JWT_SECRET || "default-pharmacy-jwt-secret-at-least-32-chars";
}

function hashOtp(otp) {
  if (otp === undefined || otp === null) return "";
  return crypto.createHmac("sha256", secret()).update(String(otp)).digest("hex");
}

function otpMatches(otp, hash) {
  if (!otp || !hash) return false;
  const computed = hashOtp(otp);
  try {
    const a = Buffer.from(computed, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const ACTION_RULES = {
  accept: {
    from: ["new"],
    to: "accepted",
    actors: ["pharmacy"],
  },
  reject: {
    from: ["new"],
    to: "rejected",
    actors: ["pharmacy"],
    validate: (order, input) => {
      if (!input?.reason || typeof input.reason !== "string" || !input.reason.trim()) {
        throw httpError(400, "Reason is required for rejection");
      }
    },
    apply: (order, input) => {
      order.rejectReason = input.reason.trim();
    },
  },
  start: {
    from: ["accepted"],
    to: "preparing",
    actors: ["pharmacy"],
  },
  ready: {
    from: ["preparing"],
    to: "ready",
    actors: ["pharmacy"],
    effects: (order) => [
      { type: "generate_otp" },
      { type: "decrement_stock", items: order.items || [] },
    ],
  },
  handover: {
    from: ["ready"],
    to: "picked_up",
    actors: ["pharmacy"],
    validate: (order, input) => {
      if (order.fulfilment !== "pickup") {
        throw httpError(409, "Handover is only allowed for pickup orders");
      }
      if (!input?.otp) {
        throw httpError(400, "OTP is required for handover");
      }
    },
    effects: (order, input) => [
      { type: "verify_otp", otp: String(input.otp) },
    ],
  },
  assign_courier: {
    from: ["ready", "delivery_failed"],
    to: "ready",
    actors: ["pharmacy"],
    validate: (order, input) => {
      if (order.fulfilment !== "delivery") {
        throw httpError(409, "Courier assignment is only allowed for delivery orders");
      }
      if (!input?.courierId || typeof input.courierId !== "string" || !input.courierId.trim()) {
        throw httpError(400, "courierId is required");
      }
    },
    apply: (order, input) => {
      order.courierId = String(input.courierId).trim();
    },
    effects: (order, input) => [
      { type: "create_delivery", courierId: String(input.courierId).trim() },
    ],
  },
  courier_pickup: {
    from: ["ready"],
    to: "out_for_delivery",
    actors: ["courier"],
    validate: (order) => {
      if (order.fulfilment !== "delivery") {
        throw httpError(409, "Courier pickup is only allowed for delivery orders");
      }
    },
  },
  deliver: {
    from: ["out_for_delivery"],
    to: "delivered",
    actors: ["courier"],
    validate: (order, input) => {
      if (!input?.otp && !input?.photoMediaId) {
        throw httpError(400, "OTP or photo proof is required for delivery");
      }
    },
    effects: (order, input) => {
      const effects = [];
      if (input?.otp) {
        effects.push({ type: "verify_otp", otp: String(input.otp) });
      }
      effects.push({
        type: "close_delivery",
        status: "delivered",
        ...(input?.photoMediaId ? { photoMediaId: input.photoMediaId } : {}),
      });
      return effects;
    },
  },
  fail: {
    from: ["out_for_delivery"],
    to: "delivery_failed",
    actors: ["courier"],
    effects: (order, input) => [
      { type: "close_delivery", status: "failed", reason: input?.reason || "" },
    ],
  },
  cancel: {
    from: ["new", "accepted", "preparing"],
    to: "cancelled",
    actors: ["patient", "pharmacy"],
  },
};

function transition(order, action, actor, input = {}) {
  if (!order || typeof order !== "object") {
    throw httpError(400, "Order is required");
  }

  const rule = ACTION_RULES[action];
  if (!rule) {
    throw httpError(400, `Unknown action: ${action}`);
  }

  // 1. Status transition check
  if (!rule.from.includes(order.status)) {
    throw httpError(409, `Cannot transition order from status ${order.status} via action ${action}`);
  }

  // 2. Actor kind check
  if (!rule.actors.includes(actor?.kind)) {
    throw httpError(403, `Actor kind ${actor?.kind} is not authorized for action ${action}`);
  }

  // 3. Actor scope checks
  if (actor.kind === "pharmacy") {
    const ids = (actor.pharmacyIds || []).map(String);
    if (!ids.includes(String(order.pharmacyId))) {
      throw httpError(403, "Pharmacist is not authorized for this pharmacy's orders");
    }
  } else if (actor.kind === "courier") {
    if (String(order.courierId) !== String(actor.id)) {
      throw httpError(403, "Courier is not assigned to this order");
    }
  } else if (actor.kind === "patient") {
    if (String(order.patientId) !== String(actor.id)) {
      throw httpError(403, "Patient does not own this order");
    }
  }

  // 4. Action-specific validation
  if (rule.validate) {
    rule.validate(order, input);
  }

  // 5. Clone and apply mutations
  const newOrder = JSON.parse(JSON.stringify(order));

  if (rule.apply) {
    rule.apply(newOrder, input);
  }

  newOrder.status = rule.to;
  newOrder.statusHistory = Array.isArray(newOrder.statusHistory) ? [...newOrder.statusHistory] : [];
  newOrder.statusHistory.push({
    status: rule.to,
    at: new Date(),
    byKind: actor.kind || "",
    byId: String(actor.id || ""),
    note: input.reason || input.note || "",
  });

  const effects = rule.effects ? rule.effects(newOrder, input) : [];

  return { order: newOrder, effects };
}

module.exports = {
  ORDER_STATUSES,
  transition,
  hashOtp,
  otpMatches,
};
