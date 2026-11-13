# Pharmacy Backend Implementation Report

**Task:** `rxback`  
**Worktree:** `/home/vinay/mc3-rxback`  
**Branch:** `par3/rxback`  
**Base Plan:** `docs/superpowers/plans/2026-11-11-pharmacy-backend.md`  
**Specification:** `docs/superpowers/specs/2026-11-11-native-pharmacy-suite-design.md` (Sections 4.1–4.5, 8.1)

---

## 1. Executive Summary

All 7 tasks of the pharmacy backend implementation plan, plus the demo seeding script and autonomous agent identity allowlist routes, have been fully implemented, tested, and committed according to specification.

Key achievements:
- **Zero Schema Bloat:** All records are modeled on the existing generic `public.medicluster_records` document store using `defineModel`.
- **Pure State Machine:** Single source of truth in `services/pharmacyOrders.js` driving order transitions, validations, role permissions, and side-effects.
- **Strict Role-Based Access Control:** Separate JWT session kinds (`pharmacy`, `courier`, `clinician`, `patient`, `agent`) with hard isolation across endpoints.
- **Cryptographic Security & Privacy:** Handover OTPs are 4 digits, stored as HMAC-SHA256 hashes, evaluated with `crypto.timingSafeEqual`, and rate-limited to 5 attempts before 429 lockouts. Couriers receive restricted projections containing zero clinical details or drug information.
- **Agent Refill Suggestion Safety:** The agent route `POST /api/pharmacy/agent/refill-suggestion` creates only a `RefillSuggestion` document (`pending_clinician_approval`) and is strictly forbidden from creating orders or prescriptions.
- **Seed Script:** `scripts/seedPharmacyDemo.js` seeds 2 demo pharmacies with 10 essential stocked medications each, 1 pharmacist per pharmacy, and 2 couriers. Passwords are read strictly from `PHARMA_DEMO_PASSWORD`.
- **100% Green Test Suite:** 309 tests passing across the entire backend (`npm test`).

---

## 2. Architecture & Implementation

### 2.1 Models (`medicluster/backend/models/`)
- `Pharmacy.js`: Pharmacy directory (name, address, lat/lng, phone, active).
- `PharmacyStaff.js`: Pharmacist and courier accounts (role, email/phone, passwordHash, pharmacyIds, active).
- `Prescription.js`: Clinician prescriptions with items (drug, dose, strength, form, frequency, quantity, instructions).
- `PharmacyOrder.js`: Patient orders with source (`prescription` or `refill`), status history, and fulfilment type (`pickup` or `delivery`).
- `PharmacyOrderOtp.js`: Plaintext OTP temporary storage for patient retrieval during `ready` or `out_for_delivery`, purged upon order completion (`picked_up`, `delivered`, `cancelled`).
- `PharmacyStock.js`: Inventory tracking (quantity, reorderThreshold, barcode, strength, form).
- `Delivery.js`: Courier assignments, acceptance, photo/OTP proof, and real-time location telemetry.
- `RefillSuggestion.js`: Autonomous agent adherence refill suggestions for clinician review (`status: pending_clinician_approval`).

### 2.2 Migrations (`supabase/migrations/`)
- `20261111_pharmacy.sql`: Added unique indexes on:
  - `lower(btrim(data->>'email'))` for `pharmacystaffs` where `data ? 'email'`
  - `data->>'phone'` for `pharmacystaffs` where `data ? 'phone'`
- Integrated into `tests/helpers/supabaseTestDb.js`.

### 2.3 Authentication & Session Kinds (`middleware/auth.js`)
- `signStaffToken(staff)`: Issues JWT with kind `"pharmacy"` or `"courier"` and 12-hour TTL.
- `readSession(req)`: Updated to recognize staff sessions while strictly distinguishing them from clinician and patient sessions.
- `requirePharmacist` & `requireCourier`: Validate staff role and inject `req.staff = { id, name, role, pharmacyIds }`.
- `AGENT_ROUTES` allowlist updated with:
  - `GET /api/pharmacy/agent/stock-low`
  - `GET /api/pharmacy/agent/stuck-orders`
  - `POST /api/pharmacy/agent/refill-suggestion`

### 2.4 State Machine & Store (`services/`)
- `services/pharmacyOrders.js`: Pure deterministic state machine specifying valid transitions (`new` → `accepted` → `preparing` → `ready` → `picked_up` / `out_for_delivery` → `delivered` / `delivery_failed`, `rejected`, `cancelled`).
- `services/pharmacyOrderStore.js`:
  - `applyAction`: Applies state transitions, decrements stock on `ready`, manages deliveries, transitions prescription to `fulfilled` on order handover/delivery, and manages `PharmacyOrderOtp` lifecycle.
  - `publicOrder(order, viewerKind)`: Role-tailored projection stripping sensitive OTP hashes and stripping all clinical data for couriers.

### 2.5 API Endpoints

#### Staff Authentication (`routes/pharmacyAuthRoutes.js`)
- `POST /api/pharmacy-auth/login`: Pharmacist sign-in by email and password.
- `POST /api/courier-auth/login`: Courier sign-in by phone and PIN.

#### Clinician Prescriptions & Directory (`routes/prescriptionRoutes.js`)
- `POST /api/prescriptions`: Prescribe medications (1–20 items, validated).
- `GET /api/prescriptions`: List prescriptions with filters.
- `PATCH /api/prescriptions/:id`: Clinician cancellation.
- `GET /api/pharmacies`: List active pharmacies.

#### Pharmacist Operations (`routes/pharmacyRoutes.js`)
- `GET /api/pharmacy/orders`: Filter queue by status and pharmacy.
- `GET /api/pharmacy/orders/:id`: Pharmacy order details.
- `POST /api/pharmacy/orders/:id/actions`: `accept`, `reject`, `start`, `ready`, `assign_courier`, `handover`.
- `GET /api/pharmacy/couriers`: List available couriers.
- `GET /api/pharmacy/stock`: Inventory listing.
- `POST /api/pharmacy/stock`: Add stock.
- `PATCH /api/pharmacy/stock/:id`: Adjust quantities.
- `GET /api/pharmacy/stock/lookup`: Barcode lookup.

#### Courier Operations (`routes/courierRoutes.js`)
- `GET /api/courier/deliveries`: List assigned deliveries.
- `GET /api/courier/deliveries/:id`: Delivery detail with privacy-sanitized order projection.
- `POST /api/courier/deliveries/:id/accept`: Accept assignment.
- `POST /api/courier/deliveries/:id/actions`: `pickup`, `deliver` (with OTP or photo proof), `fail`.
- `POST /api/courier/deliveries/:id/location`: High-frequency location updates (drops stale fixes, validates coordinates).

#### Patient-App Orders & Refills (`routes/patientPharmacyRoutes.js` & `routes/reminderRoutes.js`)
- `GET /api/patient-app/:patientId/prescriptions`: Patient prescriptions.
- `GET /api/patient-app/:patientId/pharmacies`: Nearby pharmacies sorted by Haversine distance if coordinates are supplied, or by name.
- `POST /api/patient-app/:patientId/orders`: Order placement from prescription or refill.
- `GET /api/patient-app/:patientId/orders`: Order history.
- `GET /api/patient-app/:patientId/orders/:id`: Detail with `handoverOtp` (while ready/out_for_delivery) and live `courierLocation` (while out_for_delivery).
- `POST /api/patient-app/:patientId/orders/:id/cancel`: Allowed while `new`, `accepted`, `preparing`; 409 if `ready`.
- `PATCH /api/reminders/:id`: Accepts optional `refillPharmacyId` and creates refill order returning `{ ...reminder, refillOrderId }`.

#### Autonomous Agent Routes (`routes/pharmacyAgentRoutes.js`)
- `GET /api/pharmacy/agent/stock-low`: Low stock items at or below reorder threshold.
- `GET /api/pharmacy/agent/stuck-orders`: Orders stuck past a duration threshold in intermediate states.
- `POST /api/pharmacy/agent/refill-suggestion`: Records adherence suggestion for clinician review.

#### Demo Seed Script (`scripts/seedPharmacyDemo.js`)
- Seeds MediCluster Central Pharmacy and MediCluster Southside Pharmacy with 10 stocked drugs.
- Seeds 2 pharmacists and 2 couriers.
- Requires `PHARMA_DEMO_PASSWORD`.

#### API Reference Documentation (`docs/pharmacy-api.md`)
- Complete request/response shapes, schema models, and state diagrams.

---

## 3. Test Suites & Verification

### 3.1 Dedicated Pharmacy Test Suites
1. `tests/pharmacyAuth.test.js`: 6 tests passing (login, invalid credentials, inactive staff, cross-role guards).
2. `tests/pharmacyOrders.test.js`: 11 tests passing (state machine transitions, OTP hashing, stock decrements, double-actions, immutability).
3. `tests/prescriptions.test.js`: 5 tests passing (creation, validation, list/cancel, auth guards).
4. `tests/pharmacyRoutes.test.js`: 8 tests passing (order queue, lifecycle, OTP attempts, stock management).
5. `tests/courierRoutes.test.js`: 6 tests passing (assigned isolation, lifecycle, photo proof, location telemetry, privacy).
6. `tests/patientPharmacy.test.js`: 6 tests passing (ownership 403, distance sorting, validation, OTP/location visibility, reminder refill link).
7. `tests/pharmacyChain.test.js`: 2 end-to-end chain tests passing (prescribe → order → prepare → dispatch → live tracking → OTP handover → fulfilled; reminder refill flow).
8. `tests/pharmacyAgent.test.js`: 3 tests passing (stock-low, stuck-orders, refill-suggestion safety & role isolation).

### 3.2 Full Backend Regression Suite
- Total tests: **309**
- Passed: **309**
- Failed: **0**
- Duration: 151s

---

## 4. Git Commits Log

All commits adhere to conventional commits:
```
b11a440 feat(pharmacy): add agent identity routes and demo pharmacy seed script
f53fe96 test(pharmacy): add end-to-end order chain and API reference
4074b9d feat(pharmacy): add patient order routes and refill link
7821615 feat(pharmacy): add courier delivery routes
307415e feat(pharmacy): add pharmacist order and stock routes
555f489 feat(pharmacy): add clinician prescription routes
1c2b828 feat(pharmacy): add order state machine
2695810 feat(pharmacy): add pharmacy models and staff auth
```
