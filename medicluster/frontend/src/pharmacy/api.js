// MediCluster Pharmacy Suite — API Client
// Implements binding API contract from docs/superpowers/specs/2026-11-11-native-pharmacy-suite-design.md Section 4.4

import {
  getPharmacistToken,
  setPharmacistSession,
  clearPharmacistSession,
  getCourierToken,
  setCourierSession,
  clearCourierSession,
  getActivePharmacyId,
} from './session.js';

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isConflict = status === 409;
    this.isUnauthorized = status === 401;
  }
}

/**
 * Common request wrapper for pharmacy and courier roles.
 */
async function apiRequest(endpoint, { method = 'GET', body, params, role = 'pharmacy', signal } = {}) {
  let url = endpoint;
  if (params && Object.keys(params).length > 0) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        search.append(k, String(v));
      }
    }
    const query = search.toString();
    if (query) url += `${url.includes('?') ? '&' : '?'}${query}`;
  }

  const headers = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const token = role === 'courier' ? getCourierToken() : getPharmacistToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`Network error: ${err.message}`, 0);
  }

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    data = await res.text();
  }

  if (res.status === 401 && /\/api\/(courier|pharmacy)-auth\/login$/.test(String(endpoint))) {
    throw new ApiError(role === 'courier' ? 'Wrong mobile number or PIN.' : 'Wrong email or password.', 401, data);
  }

  if (res.status === 401) {
    if (role === 'courier') {
      clearCourierSession();
    } else {
      clearPharmacistSession();
    }
    throw new ApiError('Session expired. Please sign in again.', 401, data);
  }

  if (res.status === 409) {
    const msg = (data && typeof data === 'object' && data.error) || 'Order was already changed by someone else. Please refresh.';
    throw new ApiError(msg, 409, data);
  }

  if (!res.ok) {
    const errorMsg = (data && typeof data === 'object' && (data.error || data.message))
      || (typeof data === 'string' && data)
      || `Request failed with status ${res.status}`;
    throw new ApiError(errorMsg, res.status, data);
  }

  return data;
}

// Backend documents carry Mongo `_id`; screens key and route on `id`.
const withId = (o) => (o && typeof o === 'object' && !Array.isArray(o) && !o.id && o._id ? { ...o, id: String(o._id) } : o);
function normalizeIds(data) {
  if (Array.isArray(data)) return data.map(withId);
  if (data && typeof data === 'object') {
    const out = withId(data);
    for (const k of ['orders', 'deliveries', 'items', 'order', 'delivery']) {
      if (Array.isArray(out[k])) out[k] = out[k].map(withId);
      else if (out[k] && typeof out[k] === 'object') out[k] = withId(out[k]);
    }
    return out;
  }
  return data;
}

/* =========================================================================
   Pharmacist Authentication & Operations
   ========================================================================= */

/**
 * Pharmacist login with email and password (spec 4.1).
 */
export async function loginPharmacist({ email, password }) {
  const data = await apiRequest('/api/pharmacy-auth/login', {
    method: 'POST',
    body: { email, password },
    role: 'pharmacy',
  });
  if (Array.isArray(data?.pharmacies)) data.pharmacies = data.pharmacies.map(withId);
  setPharmacistSession(data);
  return data;
}

/**
 * List orders filtered by pharmacyId and optional status.
 */
export async function getPharmacyOrders({ pharmacyId = getActivePharmacyId(), status, signal } = {}) {
  return normalizeIds(await apiRequest('/api/pharmacy/orders', {
    method: 'GET',
    params: { pharmacyId, status },
    role: 'pharmacy',
    signal,
  }));
}

/**
 * Fetch a single order by ID.
 */
export async function getPharmacyOrder(id, { signal } = {}) {
  return normalizeIds(await apiRequest(`/api/pharmacy/orders/${id}`, {
    method: 'GET',
    role: 'pharmacy',
    signal,
  }));
}

/**
 * Execute an order action (accept, reject, start, ready, handover, assign_courier, cancel).
 */
export async function executeOrderAction(id, { action, reason, otp, courierId } = {}) {
  return apiRequest(`/api/pharmacy/orders/${id}/actions`, {
    method: 'POST',
    body: { action, reason, otp, courierId },
    role: 'pharmacy',
  });
}

/**
 * List available couriers for a pharmacy.
 */
export async function getPharmacyCouriers({ pharmacyId = getActivePharmacyId(), signal } = {}) {
  return apiRequest('/api/pharmacy/couriers', {
    method: 'GET',
    params: { pharmacyId },
    role: 'pharmacy',
    signal,
  });
}

/**
 * List or search pharmacy stock inventory.
 */
export async function getPharmacyStock({ pharmacyId = getActivePharmacyId(), barcode, signal } = {}) {
  return apiRequest('/api/pharmacy/stock', {
    method: 'GET',
    params: { pharmacyId, barcode },
    role: 'pharmacy',
    signal,
  });
}

/**
 * Add a new item to pharmacy stock.
 */
export async function addPharmacyStock(stockItem) {
  return apiRequest('/api/pharmacy/stock', {
    method: 'POST',
    body: stockItem,
    role: 'pharmacy',
  });
}

/**
 * Update stock (e.g. quantity adjust or threshold).
 */
export async function updatePharmacyStock(patch) {
  return apiRequest('/api/pharmacy/stock', {
    method: 'PATCH',
    body: patch,
    role: 'pharmacy',
  });
}

/* =========================================================================
   Courier Authentication & Operations
   ========================================================================= */

/**
 * Courier login with phone and PIN (spec 4.1).
 */
export async function loginCourier({ phone, pin }) {
  const data = await apiRequest('/api/courier-auth/login', {
    method: 'POST',
    body: { phone, pin },
    role: 'courier',
  });
  setCourierSession(data);
  return data;
}

/**
 * List deliveries for the logged-in courier.
 */
export async function getCourierDeliveries({ status, signal } = {}) {
  return normalizeIds(await apiRequest('/api/courier/deliveries', {
    method: 'GET',
    params: { status },
    role: 'courier',
    signal,
  }));
}

/**
 * Get single delivery detail with patient address and items.
 */
export async function getCourierDelivery(id, { signal } = {}) {
  return normalizeIds(await apiRequest(`/api/courier/deliveries/${id}`, {
    method: 'GET',
    role: 'courier',
    signal,
  }));
}

/**
 * Accept an assigned delivery job.
 */
export async function acceptCourierDelivery(id) {
  return apiRequest(`/api/courier/deliveries/${id}/accept`, {
    method: 'POST',
    role: 'courier',
  });
}

/**
 * Execute delivery action (pickup, deliver, fail).
 */
export async function executeCourierAction(id, { action, otp, photoMediaId, reason, note } = {}) {
  return apiRequest(`/api/courier/deliveries/${id}/actions`, {
    method: 'POST',
    body: { action, otp, photoMediaId, reason, note },
    role: 'courier',
  });
}

/**
 * Post courier live GPS fix to delivery.
 */
export async function sendCourierLocation(id, { lat, lng, accuracy, observedAt }) {
  return apiRequest(`/api/courier/deliveries/${id}/location`, {
    method: 'POST',
    body: {
      lat,
      lng,
      accuracy: accuracy || 5,
      observedAt: observedAt || new Date().toISOString(),
    },
    role: 'courier',
  });
}
