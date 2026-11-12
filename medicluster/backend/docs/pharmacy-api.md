# MediCluster Pharmacy Suite API Reference

This document describes the HTTP API contract for the MediCluster native pharmacy suite, covering clinician prescribing, patient ordering, pharmacy management, and courier dispatch.

---

## 1. Authentication & Roles

MediCluster issues signed JWT Bearer tokens with distinct session `kind`s:
- `clinician`: Clinician dashboard (`User` model)
- `patient`: Patient mobile / web app (`patientId`)
- `pharmacy`: Pharmacist staff (`PharmacyStaff` model with role `pharmacist`)
- `courier`: Courier delivery agent (`PharmacyStaff` model with role `courier`)
- `agent`: Autonomous agent-core service (allowlisted endpoints only)

Include token in all protected requests:
```http
Authorization: Bearer <jwt-token>
```

---

## 2. Staff Authentication

### 2.1 Pharmacist Login
- **Endpoint:** `POST /api/pharmacy-auth/login`
- **Request:**
  ```json
  {
    "email": "pharmacist@hospital.org",
    "password": "Password123"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "token": "<jwt-token>",
    "staff": {
      "id": "6733ab01...",
      "name": "Jane Doe",
      "email": "pharmacist@hospital.org",
      "role": "pharmacist",
      "pharmacyIds": ["6733ab00..."]
    },
    "pharmacies": [
      {
        "_id": "6733ab00...",
        "name": "Main Hospital Pharmacy",
        "address": "100 Medical Blvd",
        "active": true
      }
    ]
  }
  ```
- **Errors:** `401 {"error": "Invalid credentials"}`

### 2.2 Courier Login
- **Endpoint:** `POST /api/courier-auth/login`
- **Request:**
  ```json
  {
    "phone": "+919999900010",
    "pin": "1234"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "token": "<jwt-token>",
    "staff": {
      "id": "6733ac01...",
      "name": "Bob Courier",
      "phone": "+919999900010",
      "role": "courier",
      "pharmacyIds": ["6733ab00..."]
    }
  }
  ```
- **Errors:** `401 {"error": "Invalid credentials"}`

---

## 3. Clinician Prescriptions & Directory

Guard: `requireAuth` (clinician token)

### 3.1 Create Prescription
- **Endpoint:** `POST /api/prescriptions`
- **Request:**
  ```json
  {
    "patientId": "pat_12345",
    "items": [
      {
        "drug": "Amoxicillin",
        "strength": "500mg",
        "form": "capsule",
        "dose": "1 capsule",
        "frequency": "tid",
        "durationDays": 7,
        "quantity": 21,
        "instructions": "Take with meals"
      }
    ],
    "notes": "Post-op dental antibiotic",
    "pharmacyId": "6733ab00..."
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "_id": "6733ad01...",
    "patientId": "pat_12345",
    "doctorUserId": "67330001...",
    "items": [...],
    "notes": "Post-op dental antibiotic",
    "status": "active",
    "createdAt": "2026-11-12T10:00:00.000Z"
  }
  ```

### 3.2 List Prescriptions
- **Endpoint:** `GET /api/prescriptions?patientId=pat_12345&status=active`
- **Response (200 OK):** `[ Prescription, ... ]`

### 3.3 Cancel Prescription
- **Endpoint:** `PATCH /api/prescriptions/:id`
- **Request:** `{"status": "cancelled"}`
- **Response (200 OK):** Updated `Prescription`

### 3.4 List Clinician Active Pharmacies
- **Endpoint:** `GET /api/pharmacies`
- **Response (200 OK):** `[ Pharmacy, ... ]`

---

## 4. Patient-App Pharmacy & Orders

Guard: `requirePatientOrClinician` with ownership check on `:patientId`.

### 4.1 List Prescriptions for Patient
- **Endpoint:** `GET /api/patient-app/:patientId/prescriptions`
- **Response (200 OK):** `[ Prescription, ... ]`

### 4.2 List Nearby Pharmacies
- **Endpoint:** `GET /api/patient-app/:patientId/pharmacies?lat=12.971&lng=77.592`
- **Response (200 OK):**
  ```json
  [
    {
      "_id": "6733ab00...",
      "name": "Main Hospital Pharmacy",
      "address": "100 Medical Blvd",
      "lat": 12.971,
      "lng": 77.592,
      "phone": "555-0100",
      "active": true,
      "distanceKm": 0.1
    }
  ]
  ```

### 4.3 Create Order
- **Endpoint:** `POST /api/patient-app/:patientId/orders`
- **Request (From Prescription):**
  ```json
  {
    "pharmacyId": "6733ab00...",
    "source": { "type": "prescription", "prescriptionId": "6733ad01..." },
    "fulfilment": "delivery",
    "deliveryAddress": {
      "text": "123 Maple Ave, Apt 4B",
      "lat": 12.975,
      "lng": 77.595
    }
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "_id": "6733ae01...",
    "patientId": "pat_12345",
    "pharmacyId": "6733ab00...",
    "source": { "type": "prescription", "prescriptionId": "6733ad01..." },
    "items": [...],
    "fulfilment": "delivery",
    "deliveryAddress": { "text": "123 Maple Ave, Apt 4B", "lat": 12.975, "lng": 77.595 },
    "status": "new",
    "statusHistory": [{ "status": "new", "at": "...", "byKind": "patient" }]
  }
  ```

### 4.4 Get Order Detail (with Handover OTP & Live Courier Location)
- **Endpoint:** `GET /api/patient-app/:patientId/orders/:id`
- **Response (200 OK):**
  ```json
  {
    "_id": "6733ae01...",
    "status": "out_for_delivery",
    "fulfilment": "delivery",
    "items": [...],
    "deliveryAddress": { "text": "123 Maple Ave, Apt 4B", "lat": 12.975, "lng": 77.595 },
    "handoverOtp": "4921",
    "courierLocation": {
      "lat": 12.974,
      "lng": 77.594,
      "accuracy": 6,
      "observedAt": "2026-11-12T10:35:00.000Z"
    }
  }
  ```
  *(Note: `handoverOtp` is only visible when order status is `ready` or `out_for_delivery`. `courierLocation` is only visible when status is `out_for_delivery`.)*

### 4.5 Cancel Order
- **Endpoint:** `POST /api/patient-app/:patientId/orders/:id/cancel`
- **Request:** `{"reason": "Changed my mind"}`
- **Response (200 OK):** Updated order with status `"cancelled"`.
- **Errors:** `409 Conflict` if order is already `ready` or beyond.

### 4.6 Medication Reminder Refill Link
- **Endpoint:** `PATCH /api/reminders/:id`
- **Request:**
  ```json
  {
    "refillPharmacyId": "6733ab00...",
    "fulfilment": "pickup"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "_id": "6733af01...",
    "patientId": "pat_12345",
    "medicationName": "Lisinopril",
    "refillOrderId": "6733ae02..."
  }
  ```

---

## 5. Pharmacist Operations

Guard: `requirePharmacist` (pharmacist staff token)

### 5.1 List Pharmacy Orders
- **Endpoint:** `GET /api/pharmacy/orders?pharmacyId=6733ab00...&status=new`
- **Response (200 OK):** `[ PharmacyOrder, ... ]`

### 5.2 Transition Order Actions
- **Endpoint:** `POST /api/pharmacy/orders/:id/actions`
- **Actions:**
  - `accept`: `{"action": "accept"}` (`new` → `accepted`)
  - `reject`: `{"action": "reject", "reason": "Out of stock"}` (`new` → `rejected`)
  - `start`: `{"action": "start"}` (`accepted` → `preparing`)
  - `ready`: `{"action": "ready"}` (`preparing` → `ready`; generates OTP & decrements stock)
  - `assign_courier`: `{"action": "assign_courier", "courierId": "6733ac01..."}`
  - `handover`: `{"action": "handover", "otp": "4921"}` (`ready` → `picked_up` for pickup orders)
- **Response (200 OK):**
  ```json
  {
    "order": { ... },
    "stockWarnings": [ ... ]
  }
  ```

### 5.3 Stock & Inventory Control
- **List Stock:** `GET /api/pharmacy/stock?pharmacyId=6733ab00...`
- **Add Stock:** `POST /api/pharmacy/stock` (`{ pharmacyId, drug, strength?, form?, quantity, reorderThreshold?, barcode? }`)
- **Adjust Stock:** `PATCH /api/pharmacy/stock/:id` (`{ delta: -5 }` or `{ quantity: 45 }`)
- **Barcode Lookup:** `GET /api/pharmacy/stock/lookup?barcode=1234567890`

### 5.4 List Couriers
- **Endpoint:** `GET /api/pharmacy/couriers?pharmacyId=6733ab00...`
- **Response (200 OK):** `[ PharmacyStaff (role=courier), ... ]`

---

## 6. Courier Operations

Guard: `requireCourier` (courier staff token)

### 6.1 List Assigned Deliveries
- **Endpoint:** `GET /api/courier/deliveries?status=assigned`
- **Response (200 OK):** `[ Delivery, ... ]`

### 6.2 Accept Delivery
- **Endpoint:** `POST /api/courier/deliveries/:id/accept`
- **Response (200 OK):** `{"delivery": { ...status: "accepted" }}`

### 6.3 Delivery Actions
- **Endpoint:** `POST /api/courier/deliveries/:id/actions`
- **Actions:**
  - `pickup`: `{"action": "pickup"}` (`accepted` → `picked_up`, order becomes `out_for_delivery`)
  - `deliver` (with OTP): `{"action": "deliver", "otp": "4921"}`
  - `deliver` (with photo): `{"action": "deliver", "photoMediaId": "media_987"}`
  - `fail`: `{"action": "fail", "reason": "Customer not home"}`
- **Response (200 OK):**
  ```json
  {
    "delivery": { ... },
    "order": {
      "_id": "...",
      "status": "delivered",
      "fulfilment": "delivery",
      "deliveryAddress": { ... },
      "patientFirstName": "Jane",
      "patientPhone": "+919876543210"
    }
  }
  ```
  *(Courier view excludes clinical prescription items, drug details, notes, and OTP hashes).*

### 6.4 Courier Location Telemetry
- **Endpoint:** `POST /api/courier/deliveries/:id/location`
- **Request:**
  ```json
  {
    "lat": 12.9735,
    "lng": 77.5938,
    "accuracy": 5.2,
    "observedAt": "2026-11-12T10:35:12.345Z"
  }
  ```
- **Response:**
  - `200 OK` on valid location update
  - `204 No Content` if `observedAt` is not newer than current fix
  - `400 Bad Request` if coordinates are out of bounds
  - `409 Conflict` if delivery is not `accepted` or `picked_up`

---

## 7. Order State Transition Summary

```
                  ┌─────────┐
                  │   new   │
                  └──┬───┬──┘
         (reject)   │   │   (accept)
     ┌──────────────┘   └─────────────┐
     ▼                                ▼
┌──────────┐                     ┌──────────┐
│ rejected │                     │ accepted │
└──────────┘                     └────┬─────┘
                                      │ (start)
                                      ▼
                                ┌───────────┐
                                │ preparing │
                                └─────┬─────┘
                                      │ (ready)
                                      ▼
                                ┌───────────┐
                     ┌──────────┤   ready   ├──────────┐
                     │          └─────┬─────┘          │
                     │ (handover)     │ (courier_pickup)
                     ▼                ▼                ▼
               ┌───────────┐    ┌──────────────────┐
               │ picked_up │    │ out_for_delivery │
               └───────────┘    └─────┬──────┬─────┘
                                      │      │ (fail)
                     (deliver with    │      ▼
                    OTP or photo proof) ┌─────────────────┐
                                      ▼ │ delivery_failed │
                                ┌───────────┐ └────────┬────────┘
                                │ delivered │          │ (re-assign courier)
                                └───────────┘          └────────┘
```
- Orders in `new`, `accepted`, or `preparing` can be `cancel`led by patient or pharmacy.
- `ready` emits `generate_otp` (plain OTP stored in `PharmacyOrderOtp` for patient) and `decrement_stock`.
- Pickup orders complete via pharmacist `handover` verifying patient OTP.
- Delivery orders complete via courier `deliver` verifying patient OTP or photo proof.
- Upon `picked_up` or `delivered`, prescription status transitions to `fulfilled`, and plain OTP is purged.
