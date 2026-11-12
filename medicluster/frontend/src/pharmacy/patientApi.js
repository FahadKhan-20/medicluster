/**
 * src/pharmacy/patientApi.js
 * API client methods matching binding API contract in spec section 4.4.
 */

import api from "../api/apiClient";
export * from "./pharmacyOrderUtils";

// ── Clinician Routes (spec 4.4) ──────────────────────────────────────────────

/**
 * List active pharmacies for the clinician Prescribe panel.
 * GET /api/pharmacies
 */
export async function listPharmacies() {
  const res = await api.get("/pharmacies");
  return res.data;
}

/**
 * Create a prescription for a patient.
 * POST /api/prescriptions
 * Body: { patientId, doctorUserId?, items, notes?, pharmacyId? }
 */
export async function createPrescription(data) {
  const res = await api.post("/prescriptions", data);
  return res.data;
}

/**
 * List prescriptions for a specific patient.
 * GET /api/prescriptions?patientId=...
 */
export async function listPrescriptions(patientId) {
  const res = await api.get("/prescriptions", {
    params: { patientId },
  });
  return res.data;
}

/**
 * Cancel an active prescription.
 * PATCH /api/prescriptions/:id
 */
export async function cancelPrescription(prescriptionId) {
  const res = await api.patch(`/prescriptions/${encodeURIComponent(prescriptionId)}`, {
    status: "cancelled",
  });
  return res.data;
}

// ── Patient Routes (spec 4.4) ────────────────────────────────────────────────

/**
 * List prescriptions for the authenticated patient.
 * GET /api/patient-app/:patientId/prescriptions
 */
export async function getPatientPrescriptions(patientId) {
  const res = await api.get(`/patient-app/${encodeURIComponent(patientId)}/prescriptions`);
  return res.data;
}

/**
 * List nearby pharmacies sorted by distance.
 * GET /api/patient-app/:patientId/pharmacies?lat=&lng=
 */
export async function getNearbyPharmacies(patientId, { lat, lng } = {}) {
  const params = {};
  if (lat != null) params.lat = lat;
  if (lng != null) params.lng = lng;
  const res = await api.get(`/patient-app/${encodeURIComponent(patientId)}/pharmacies`, { params });
  return res.data;
}

/**
 * Create a pharmacy order (pickup or delivery).
 * POST /api/patient-app/:patientId/orders
 * Body: { source: { type: "prescription"|"refill", prescriptionId?|reminderId? }, pharmacyId, fulfilment, deliveryAddress?, items? }
 */
export async function createOrder(patientId, orderData) {
  const res = await api.post(`/patient-app/${encodeURIComponent(patientId)}/orders`, orderData);
  return res.data;
}

/**
 * List all orders for the authenticated patient.
 * GET /api/patient-app/:patientId/orders
 */
export async function getOrders(patientId) {
  const res = await api.get(`/patient-app/${encodeURIComponent(patientId)}/orders`);
  return res.data;
}

/**
 * Get detailed status, history, handover OTP (if ready), and courier location (if out_for_delivery) for an order.
 * GET /api/patient-app/:patientId/orders/:id
 */
export async function getOrder(patientId, orderId) {
  const res = await api.get(`/patient-app/${encodeURIComponent(patientId)}/orders/${encodeURIComponent(orderId)}`);
  return res.data;
}

/**
 * Cancel an order if it is in new, accepted, or preparing status.
 * POST /api/patient-app/:patientId/orders/:id/cancel
 */
export async function cancelOrder(patientId, orderId) {
  const res = await api.post(`/patient-app/${encodeURIComponent(patientId)}/orders/${encodeURIComponent(orderId)}/cancel`);
  return res.data;
}

/**
 * Request a refill on a reminder, optionally placing a pharmacy order directly.
 * PATCH /api/reminders/:id
 */
export async function requestRefill(reminderId, refillData = {}) {
  const res = await api.patch(`/reminders/${encodeURIComponent(reminderId)}`, {
    refillRequestedAt: new Date().toISOString(),
    ...refillData,
  });
  return res.data;
}
