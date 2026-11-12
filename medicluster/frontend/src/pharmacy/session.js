// Pharmacy & Courier Session Storage
// Strictly isolated from clinician ('medicluster.token') and patient ('medicluster.patientToken') sessions.

export const PHARMACY_TOKEN_KEY = 'medicluster.pharmacy.token';
export const PHARMACY_STAFF_KEY = 'medicluster.pharmacy.staff';
export const PHARMACY_LIST_KEY = 'medicluster.pharmacy.pharmacies';
export const PHARMACY_ACTIVE_ID_KEY = 'medicluster.pharmacy.activeId';

export const COURIER_TOKEN_KEY = 'medicluster.courier.token';
export const COURIER_STAFF_KEY = 'medicluster.courier.staff';

// Pharmacist session helpers
export function getPharmacistToken() {
  try {
    return localStorage.getItem(PHARMACY_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function getPharmacistStaff() {
  try {
    const raw = localStorage.getItem(PHARMACY_STAFF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getPharmacistPharmacies() {
  try {
    const raw = localStorage.getItem(PHARMACY_LIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function getActivePharmacyId() {
  try {
    return localStorage.getItem(PHARMACY_ACTIVE_ID_KEY) || null;
  } catch {
    return null;
  }
}

export function setActivePharmacyId(id) {
  try {
    if (id) {
      localStorage.setItem(PHARMACY_ACTIVE_ID_KEY, id);
    } else {
      localStorage.removeItem(PHARMACY_ACTIVE_ID_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

export function setPharmacistSession({ token, staff, pharmacies = [] }) {
  try {
    if (token) localStorage.setItem(PHARMACY_TOKEN_KEY, token);
    if (staff) localStorage.setItem(PHARMACY_STAFF_KEY, JSON.stringify(staff));
    if (pharmacies) localStorage.setItem(PHARMACY_LIST_KEY, JSON.stringify(pharmacies));
    const active = pharmacies[0]?.id || staff?.pharmacyIds?.[0] || null;
    if (active) setActivePharmacyId(active);
  } catch {
    /* storage unavailable */
  }
}

export function clearPharmacistSession() {
  try {
    localStorage.removeItem(PHARMACY_TOKEN_KEY);
    localStorage.removeItem(PHARMACY_STAFF_KEY);
    localStorage.removeItem(PHARMACY_LIST_KEY);
    localStorage.removeItem(PHARMACY_ACTIVE_ID_KEY);
  } catch {
    /* storage unavailable */
  }
}

// Courier session helpers
export function getCourierToken() {
  try {
    return localStorage.getItem(COURIER_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function getCourierStaff() {
  try {
    const raw = localStorage.getItem(COURIER_STAFF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCourierSession({ token, staff }) {
  try {
    if (token) localStorage.setItem(COURIER_TOKEN_KEY, token);
    if (staff) localStorage.setItem(COURIER_STAFF_KEY, JSON.stringify(staff));
  } catch {
    /* storage unavailable */
  }
}

export function clearCourierSession() {
  try {
    localStorage.removeItem(COURIER_TOKEN_KEY);
    localStorage.removeItem(COURIER_STAFF_KEY);
  } catch {
    /* storage unavailable */
  }
}
