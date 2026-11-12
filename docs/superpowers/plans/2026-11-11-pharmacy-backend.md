# Pharmacy Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pharmacies, staff accounts (pharmacist, courier), prescriptions, orders, stock and deliveries to `medicluster/backend`, with role-scoped API routes.

**Architecture:** New models on the existing generic `medicluster_records` document store (`db/model.js` `defineModel`). One pure state-machine module decides every order transition; routes are thin Express routers that call it. New JWT session kinds `pharmacy` and `courier` sit beside the existing `clinician` and `patient` kinds.

**Tech Stack:** Node.js, Express, `node:test`, PGlite test database (`tests/helpers/supabaseTestDb.js`), `jsonwebtoken`, `bcryptjs`.

**Spec:** `docs/superpowers/specs/2026-11-11-native-pharmacy-suite-design.md` (sections 4 and 8.1)

## Global Constraints

- Work only inside `medicluster/backend`. Do not edit existing tests except to add new ones; the full suite must stay green: `cd medicluster/backend && npm test`.
- Storage: no new SQL tables. Every model is a collection in `public.medicluster_records`. The only SQL is unique indexes in the new migration file.
- Staff session token: `jwt.sign({ sub, kind: "pharmacy" | "courier" }, secret(), { expiresIn: "12h" })`.
- A pharmacy or courier token must never pass `requireAuth` (clinician) or `requirePatientOrClinician`. Patient and clinician tokens must never pass `requirePharmacist` or `requireCourier`.
- `passwordHash` and `handoverOtpHash` are never returned in any response.
- OTP: 4 digits, stored as a hash, compared with `crypto.timingSafeEqual`.
- Invalid order transition: HTTP 409 `{ error }`. Wrong role or not your record: 403. No token: 401. Bad input: 400.
- Tests use synthetic data only. Use `JWT_SECRET` fixtures exactly like `tests/patientFeatures.test.js`.
- Commit after each task with a `feat(pharmacy): ...` or `test(pharmacy): ...` message. Do not push.

## Review Focus

- Pharmacist of pharmacy A acts on an order of pharmacy B: expect 403, not success. Test in Task 4.
- Courier reads or acts on a delivery assigned to another courier: expect 403. Test in Task 5.
- Patient polls order detail after delivery is finished: courier `lastLocation` must be absent. Test in Task 6.
- Two pharmacists press "accept" on the same `new` order at once: second gets 409, history has one `accepted` entry. Test in Task 2 (sequential double call) and Task 4.
- Wrong OTP five times in a row: each attempt 400, order unchanged, no OTP leak in error text. Test in Task 4.

---

### Task 1: Models, migration indexes, staff auth

**Files:**
- Create: `models/Pharmacy.js`, `models/PharmacyStaff.js`, `models/Prescription.js`, `models/PharmacyOrder.js`, `models/PharmacyStock.js`, `models/Delivery.js`
- Create: `supabase/migrations/20261111_pharmacy.sql`
- Modify: `tests/helpers/supabaseTestDb.js` (also execute `20261111_pharmacy.sql` after the storage migration)
- Modify: `middleware/auth.js`
- Create: `routes/pharmacyAuthRoutes.js` (exports two routers: `pharmacyAuth`, `courierAuth`)
- Modify: `server.js` (mount `/api/pharmacy-auth`, `/api/courier-auth`)
- Create: `scripts/seedPharmacy.js`
- Test: `tests/pharmacyAuth.test.js`

**Interfaces:**
- Produces (models, field names exactly as spec 4.1/4.2): `Pharmacy`, `PharmacyStaff`, `Prescription`, `PharmacyOrder` (adds `handoverOtpHash: String, select: false`, `otpAttempts: Number` default 0), `PharmacyStock`, `Delivery`.
- Produces in `middleware/auth.js`:
  - `signStaffToken(staff) -> string` (kind = `staff.role === "courier" ? "courier" : "pharmacy"`)
  - `readSession(req)` additionally returns `{ kind: "pharmacy" | "courier", staffId }`
  - `requirePharmacist(req, res, next)` and `requireCourier(req, res, next)`: load active `PharmacyStaff` with matching role, set `req.staff = { id, name, role, pharmacyIds }`
  - `module.exports` keeps every existing export and adds the three above.
- Produces routes: `POST /api/pharmacy-auth/login {email,password} -> { token, staff, pharmacies }`; `POST /api/courier-auth/login {phone,pin} -> { token, staff }`. Wrong credentials: 401 `{ error: "Invalid credentials" }` (same text for unknown user and wrong password).
- Migration: unique indexes on `lower(btrim(data->>'email'))` where `collection = 'pharmacystaffs' AND data ? 'email'`, and on `data->'phone'` where `collection = 'pharmacystaffs' AND data ? 'phone'`. Check the exact collection name `defineModel("PharmacyStaff", ...)` produces in `db/model.js` before writing the index.

- [ ] **Step 1: Write failing tests in `tests/pharmacyAuth.test.js`**
  - `pharmacist logs in with email and password` → 200, `token` present, `staff.passwordHash` undefined, `pharmacies` has the seeded pharmacy.
  - `courier logs in with phone and pin` → 200.
  - `wrong password and unknown email return the same 401`.
  - `inactive staff cannot log in` → 401.
  - `staff tokens are rejected by clinician and patient guards`: mount a dummy route behind `requireAuth` and one behind `requirePatientOrClinician`; pharmacy and courier tokens get 403.
  - `patient and clinician tokens are rejected by requirePharmacist and requireCourier` → 403; courier token on `requirePharmacist` → 403; no token → 401.
- [ ] **Step 2: Run** `node --test tests/pharmacyAuth.test.js` — expect FAIL (modules missing).
- [ ] **Step 3: Implement models, migration, helper change, auth middleware, login routes, mounts.** Hash with `bcryptjs` (cost 10). `readSession` must keep returning exactly the old shapes for old tokens.
- [ ] **Step 4: Implement `scripts/seedPharmacy.js`**: creates one pharmacy ("MediCluster Test Pharmacy", lat 12.9716, lng 77.5946), one pharmacist `pharmacist@test.local` / `pharm-test-1234`, one courier phone `+910000000001` / PIN `4321`. Idempotent (skip if email/phone exists). Refuses to run unless `ALLOW_SEED=1`.
- [ ] **Step 5: Run** `node --test tests/pharmacyAuth.test.js` then `npm test` — expect all PASS.
- [ ] **Step 6: Commit** `feat(pharmacy): add pharmacy models and staff auth`.

### Task 2: Order state machine

**Files:**
- Create: `services/pharmacyOrders.js`
- Test: `tests/pharmacyOrders.test.js`

**Interfaces:**
- Consumes: none (pure).
- Produces:
  - `ORDER_STATUSES` = `["new","accepted","preparing","ready","picked_up","out_for_delivery","delivered","delivery_failed","rejected","cancelled"]`
  - `transition(order, action, actor, input = {}) -> { order: newOrder, effects: Effect[] }` — never mutates its arguments. Throws `Error` with `.status = 409` for a disallowed transition, `.status = 403` for a wrong actor, `.status = 400` for bad input.
  - `actor` = `{ kind: "pharmacy" | "courier" | "patient", id, pharmacyIds? }`
  - `Effect` = `{ type: "generate_otp" } | { type: "decrement_stock", items } | { type: "create_delivery", courierId } | { type: "verify_otp", otp } | { type: "close_delivery", status }`
  - `otpMatches(otp: string, hash: string) -> boolean` and `hashOtp(otp: string) -> string` (SHA-256 hex with `JWT_SECRET` as HMAC key), compared with `timingSafeEqual`.
- Transition table is spec section 4.3 exactly. Every successful transition appends `{ status, at, byKind, byId, note }` to `statusHistory`.

- [ ] **Step 1: Write failing tests.** One table-driven test that walks every row of spec 4.3 (allowed actor, from-status, to-status). Plus:
  - `every action from a status not listed for it throws 409` (loop all actions × all statuses).
  - `pharmacist of another pharmacy throws 403` (`actor.pharmacyIds` excludes `order.pharmacyId`).
  - `courier who is not order.courierId throws 403` for `courier_pickup`, `deliver`, `fail`.
  - `ready emits generate_otp and decrement_stock`; `assign_courier emits create_delivery` and requires `fulfilment === "delivery"` (pickup order → 409).
  - `handover and deliver without otp (and deliver without photoMediaId) throw 400`.
  - `reject without reason throws 400`.
  - `accept twice: second call on the returned order throws 409`.
  - `input order object is not mutated`.
- [ ] **Step 2: Run** `node --test tests/pharmacyOrders.test.js` — FAIL.
- [ ] **Step 3: Implement** as a lookup table keyed by action: `{ from: [...], to, actors: [...], requires?: [...] }`, plus actor scope checks.
- [ ] **Step 4: Run** the test file — PASS.
- [ ] **Step 5: Commit** `feat(pharmacy): add order state machine`.

### Task 3: Clinician prescription routes

**Files:**
- Create: `routes/prescriptionRoutes.js` (exports `prescriptions` and `pharmacies` routers)
- Modify: `server.js` (mount `/api/prescriptions` and `/api/pharmacies`, both behind `requireAuth`)
- Test: `tests/prescriptions.test.js`

**Interfaces:**
- Produces: `POST /api/prescriptions { patientId, items[], notes?, pharmacyId? } -> 201 Prescription` (sets `doctorUserId = req.userId`, `status = "active"`); `GET /api/prescriptions?patientId= -> Prescription[]` newest first; `PATCH /api/prescriptions/:id { status: "cancelled" } -> Prescription` (any other status 400); `GET /api/pharmacies -> Pharmacy[]` active only.
- Item validation: `drug` non-empty string, `quantity` integer ≥ 1; `items` length 1..20.

- [ ] **Step 1: Write failing tests:** create, list for a patient, cancel, 400 on empty items / missing drug / quantity 0, 401 without token, 403 with patient token and with pharmacy token, pharmacies list hides `active: false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** routes.
- [ ] **Step 4: Run** test file and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(pharmacy): add clinician prescription routes`.

### Task 4: Pharmacist routes (orders, couriers, stock)

**Files:**
- Create: `routes/pharmacyRoutes.js`
- Create: `services/pharmacyOrderStore.js` — loads an order, calls `transition`, applies effects, saves; used by Tasks 4–6
- Modify: `server.js` (mount `/api/pharmacy` behind `requirePharmacist`)
- Test: `tests/pharmacyRoutes.test.js`

**Interfaces:**
- Consumes: `transition`, `hashOtp`, `otpMatches` (Task 2); `requirePharmacist` (Task 1).
- Produces in `services/pharmacyOrderStore.js`:
  - `applyAction(orderId, action, actor, input) -> Promise<{ order, otp? }>` — `otp` (plain 4 digits) returned only from the `ready` action and only to callers that pass it to the patient view; pharmacist responses never include it.
  - `publicOrder(order, viewerKind) -> object` — strips `handoverOtpHash`, `otpAttempts`; for `courier` viewers keeps only `{ _id, status, fulfilment, deliveryAddress, pharmacyId, patientFirstName, patientPhone }`.
  - Effects: `generate_otp` → random 4 digits via `crypto.randomInt(0, 10000)` zero-padded, store hash; `decrement_stock` → for each item, decrement matching `PharmacyStock` (same `pharmacyId`, case-insensitive `drug`), floor at 0, collect `stockWarnings[]` for missing/short rows; `create_delivery` → create `Delivery { status: "assigned" }`; `verify_otp` → on mismatch increment `otpAttempts`, throw 400 `{ error: "Wrong code" }`, after 5 failed attempts throw 429 and keep the order unchanged. After any transition to `picked_up` or `delivered` whose `source.type` is `prescription`, set that `Prescription.status = "fulfilled"`.
- Produces routes: `GET /orders?pharmacyId=&status=`, `GET /orders/:id`, `POST /orders/:id/actions { action, reason?, otp?, courierId? }` → `{ order, stockWarnings? }`, `GET /couriers?pharmacyId=` (active couriers whose `pharmacyIds` include it), `GET /stock?pharmacyId=&q=&barcode=`, `POST /stock`, `PATCH /stock/:id { quantity?, batch?, expiry?, lowStockThreshold? }`. Every route checks the pharmacy belongs to `req.staff.pharmacyIds`, else 403.

- [ ] **Step 1: Write failing tests:** queue filtered by status; full pickup path (accept → start → ready → handover with correct OTP read straight from the store test hook); wrong OTP 400 ×5 then 429 and status still `ready`; assign courier creates a `Delivery`; other pharmacy's order 403 on GET and on actions; double accept → second 409 and one `accepted` history entry; `ready` decrements stock and returns `stockWarnings` for an unstocked drug; stock add/adjust/lookup by barcode; responses never contain `handoverOtpHash`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `pharmacyOrderStore.js` then `pharmacyRoutes.js`.
- [ ] **Step 4: Run** test file and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(pharmacy): add pharmacist order and stock routes`.

### Task 5: Courier routes

**Files:**
- Create: `routes/courierRoutes.js`
- Modify: `server.js` (mount `/api/courier` behind `requireCourier`)
- Test: `tests/courierRoutes.test.js`

**Interfaces:**
- Consumes: `applyAction`, `publicOrder(order, "courier")` (Task 4).
- Produces: `GET /deliveries?status=` (own only), `GET /deliveries/:id -> { delivery, order: publicOrder(..., "courier"), pharmacy }`, `POST /deliveries/:id/accept` (`assigned` → `accepted`), `POST /deliveries/:id/actions { action: "pickup" | "deliver" | "fail", otp?, photoMediaId?, reason? }` mapping to `courier_pickup` / `deliver` / `fail`, `POST /deliveries/:id/location { lat, lng, accuracy, observedAt }`.
- Location rule: reject `lat` outside [-90,90], `lng` outside [-180,180], or non-ISO `observedAt` with 400; ignore (204, no write) a fix whose `observedAt` is not newer than the stored one; accept only while delivery status is `accepted` or `picked_up` (else 409).
- Delivery status follows order: `courier_pickup` → `picked_up`; `deliver` → `delivered` with `proof`; `fail` → `failed`.

- [ ] **Step 1: Write failing tests:** courier sees only own deliveries; other courier 403 on GET, accept, actions, location; accept → pickup → location → deliver with OTP; deliver with `photoMediaId` instead of OTP; older location fix ignored; location after delivered 409; out-of-range lat 400; courier response has no clinical fields (assert keys of `order`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** test file and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(pharmacy): add courier delivery routes`.

### Task 6: Patient order routes and refill link

**Files:**
- Create: `routes/patientPharmacyRoutes.js`
- Modify: `server.js` (mount on `/api/patient-app` before `patientAppRoutes`, same guard pattern: `requirePatientOrClinician` + `canAccessPatient`)
- Modify: `routes/reminderRoutes.js` (PATCH `/:id` optional refill order)
- Test: `tests/patientPharmacy.test.js`

**Interfaces:**
- Consumes: `applyAction`, `publicOrder` (Task 4); `Prescription`, `Pharmacy`, `Delivery`, `Reminder` models.
- Produces: `GET /:patientId/prescriptions`; `GET /:patientId/pharmacies?lat=&lng=` (each item gains `distanceKm`, haversine, sorted ascending; without lat/lng, sorted by name); `POST /:patientId/orders { source, pharmacyId, fulfilment, deliveryAddress? } -> 201`; `GET /:patientId/orders`; `GET /:patientId/orders/:id` → `publicOrder(..., "patient")` plus `handoverOtp` (plain, only while status `ready` or `out_for_delivery`) and `courierLocation` (only while `out_for_delivery`); `POST /:patientId/orders/:id/cancel`.
- The patient must read the OTP later, but `PharmacyOrder` holds only its hash. `applyAction` returns the plain OTP once at `ready`; the store keeps it in a separate collection `PharmacyOrderOtp { orderId, patientId, otp, expiresAt }` readable only by this patient route and deleted on `picked_up`, `delivered`, `cancelled`. Add this model in this task.
- Order creation rules: `source.type = "prescription"` requires an `active` prescription of this patient; items copied from it. `source.type = "refill"` requires this patient's reminder; one item `{ drug: medicationName, dose: dosage, quantity: 1 }`. `fulfilment = "delivery"` requires `deliveryAddress.text` and numeric `lat`/`lng`. Unknown/inactive pharmacy 400.
- Reminder PATCH: when body has `refillPharmacyId`, create the refill order with `fulfilment` (default `pickup`) and `deliveryAddress`, and return `{ ...reminder, refillOrderId }`. Without it, behaviour is unchanged.

- [ ] **Step 1: Write failing tests:** other patient 403; order from prescription; order from cancelled prescription 400; delivery without address 400; pharmacies sorted by distance; `handoverOtp` present only at `ready`, `courierLocation` present only during `out_for_delivery` and absent after `delivered`; cancel allowed at `new`, 409 at `ready`; reminder PATCH with `refillPharmacyId` creates an order; reminder PATCH without it still passes the existing reminder behaviour.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** test file and full `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(pharmacy): add patient order routes and refill link`.

### Task 7: End-to-end API chain test and API reference

**Files:**
- Test: `tests/pharmacyChain.test.js`
- Create: `docs/pharmacy-api.md` (in `medicluster/backend/docs/`, request/response examples for every route; native app agents read this file)

**Interfaces:**
- Consumes: every route above, mounted exactly as in `server.js` (import the real app factory if `server.js` exports one; otherwise mount the same routers in the test).

- [ ] **Step 1: Write the chain test:** clinician prescribes → patient orders delivery → pharmacist accept/start/ready/assign → courier accept/pickup/location → patient sees courier location → courier delivers with the patient's OTP → patient sees `delivered`, no location, no OTP → prescription status `fulfilled`. Second case: refill from reminder, pickup, handover.
- [ ] **Step 2: Run** — fix any integration gap in the owning task's files until PASS.
- [ ] **Step 3: Write `docs/pharmacy-api.md`** from the passing tests (real field names, real status codes).
- [ ] **Step 4: Run** `npm test` — all PASS.
- [ ] **Step 5: Commit** `test(pharmacy): add end-to-end order chain and API reference`.
