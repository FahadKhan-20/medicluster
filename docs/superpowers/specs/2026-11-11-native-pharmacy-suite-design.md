# Native Pharmacy Suite — Design

Date: 2026-11-11
Status: Draft for review

## 1. Goal

Add a full pharmacy chain to MediCluster and move every mobile app to native Android:

- A doctor writes an e-prescription in the clinician web dashboard.
- The patient orders it (or a refill) from a chosen pharmacy, as pickup or home delivery.
- The pharmacist accepts, prepares and hands over the order, and manages stock.
- A courier collects the order and delivers it, with live GPS and proof of delivery.
- The patient follows the order status and the courier on a map.

Four native Android apps (Kotlin + Jetpack Compose) are built: Pharmacy, Courier, Patient and Crew. Patient and Crew are native rewrites of the current WebView shells.

### What the user decided

- Full chain (prescription, pharmacy, delivery).
- All mobile apps fully native, Kotlin + Jetpack Compose.
- Courier is a separate app; Crew stays ambulance-only.
- Verification: local toolchain plus the user's real Android phone over USB (adb).
- Work is executed by agy agents shown in Herdr panes, all on `gemini-3.8-flash-high` (no Opus or Sonnet credits).
- Every agent's work is checked after it finishes.

### Assumptions (open to correction)

- The web versions of the patient app and crew app stay online for browser users. Native apps replace only the Android WebView shells.
- The old WebView shells (`patient-android`, `crew-android`) stay in the repository and keep shipping until the native apps pass verification.
- The backend stays the existing Node API (`medicluster/backend`) on the existing Supabase-backed model layer.
- The crew app keeps the existing ambulance-dispatch backend and Supabase project and login (employee ID + PIN).

## 2. Scope

### In scope (v1)

- Backend: pharmacy, prescription, order, stock and delivery data; pharmacist and courier accounts; new API routes; refill link from reminders.
- Clinician web: Prescribe panel on the patient page.
- Native apps: Pharmacy, Courier, Patient (all current screens plus a Pharmacy tab), Crew (driver flow).
- Docker-based Android build and test image.

### Out of scope (v1)

- Payments and pricing.
- iOS.
- FCM push notifications. Apps poll every 5 seconds while a screen is open.
- Translations in native apps. English only; web i18n stays unchanged.
- Offline mode, except the existing queued reading logs in the patient app.
- Replacing the old WebView shells in CI and the download page. A later change does this after native apps are proven.
- Production deployment, signing with release keys, pushing to remote.

## 3. Architecture

```
clinician web (React)  ──┐
patient native app ──────┤
pharmacy native app ─────┼──► medicluster/backend (Node/Express) ──► Supabase
courier native app ──────┘
crew native app ─────────────► ambulance-dispatch API + Supabase (unchanged)
```

### 3.1 Repository layout

```
medicluster/native-android/
  settings.gradle.kts
  build.gradle.kts
  gradle/libs.versions.toml
  docker/Dockerfile                 # JDK 17, Gradle 8.11.1, Android SDK 35
  core/model      # Kotlin data classes shared by all apps (kotlinx.serialization)
  core/network    # Retrofit + OkHttp client, auth header, error mapping, polling helper
  core/auth       # token store (EncryptedSharedPreferences), session state
  core/location   # fused location provider, foreground location service
  core/maps       # osmdroid map composable (no Google Maps API key)
  core/ui         # Compose theme, shared components (status chip, timeline, empty/error states)
  app-pharmacy    # applicationId com.medicluster.pharmacy
  app-courier     # applicationId com.medicluster.courier
  app-patient     # applicationId com.medicluster.patient.nativeapp
  app-crew        # applicationId com.medicluster.crew.nativeapp
```

New application IDs mean the native patient and crew apps install beside the old WebView apps on the same phone.

### 3.2 Toolchain

- Kotlin 2.x, Jetpack Compose (BOM), Material 3, Navigation Compose.
- minSdk 26, targetSdk 35, compileSdk 35.
- Retrofit, OkHttp, kotlinx.serialization, Coroutines/Flow.
- Lifecycle ViewModel; manual dependency wiring per app (no Hilt) to keep the build simple.
- CameraX + ML Kit barcode scanning (pharmacy stock).
- osmdroid for maps.
- supabase-kt for the crew app only.
- Tests: JUnit 4, kotlinx-coroutines-test, MockWebServer.
- Builds run inside `native-android/docker/Dockerfile`. `adb` runs on the host.

### 3.3 Backend base URL

Each app reads `API_BASE_URL` from a Gradle property, set at build time. The debug default points at the developer machine's local backend through `adb reverse tcp:5000 tcp:5000` (`http://127.0.0.1:5000`). Debug builds allow cleartext only to `127.0.0.1`. Release builds require HTTPS.

## 4. Backend design

All new code lives in `medicluster/backend` and follows the existing patterns: models via `db/model.js` `defineModel`, routes as Express routers, tests in `backend/tests` with the existing test runner.

### 4.1 Accounts and roles

New model `PharmacyStaff`:

| Field | Type | Notes |
|---|---|---|
| `name` | String | required |
| `role` | `"pharmacist" \| "courier"` | required |
| `email` | String | pharmacists log in with email + password |
| `phone` | String | couriers log in with phone + PIN |
| `passwordHash` | String | bcrypt; password for pharmacist, PIN for courier; never returned |
| `pharmacyIds` | [String] | pharmacies this person works for |
| `active` | Boolean | default true |

Session tokens: `jwt.sign({ sub, kind: "pharmacy" | "courier" }, secret, { expiresIn: "12h" })`.

`middleware/auth.js` changes:

- `readSession` returns `{ kind: "pharmacy", staffId }` or `{ kind: "courier", staffId }` for the new kinds. Existing patient and clinician results stay exactly the same.
- Existing `requireAuth` keeps rejecting every non-clinician token. A pharmacy or courier token must never pass clinician checks.
- New `requirePharmacist` and `requireCourier` middleware load the staff record, reject inactive staff, and set `req.staff`.

Login routes (rate-limited like patient auth):

- `POST /api/pharmacy-auth/login` `{ email, password }` → `{ token, staff, pharmacies }`
- `POST /api/courier-auth/login` `{ phone, pin }` → `{ token, staff }`

Accounts are created by a seed script (`backend/scripts/seedPharmacy.js`) for local testing. No self-signup in v1.

### 4.2 Data models

`Pharmacy`: `name`, `address`, `lat`, `lng`, `phone`, `active`.

`Prescription`:

| Field | Notes |
|---|---|
| `patientId` | required |
| `doctorUserId` | clinician `User` id |
| `items` | `[{ drug, strength, form, dose, frequency, durationDays, quantity, instructions }]`, at least one |
| `notes` | optional |
| `status` | `active \| fulfilled \| cancelled` |
| `pharmacyId` | optional preferred pharmacy chosen by the doctor |

`PharmacyOrder`:

| Field | Notes |
|---|---|
| `patientId`, `pharmacyId` | required |
| `source` | `{ type: "prescription", prescriptionId }` or `{ type: "refill", reminderId }` |
| `items` | copied from the prescription or reminder at order time |
| `fulfilment` | `pickup \| delivery` |
| `deliveryAddress` | `{ text, lat, lng }`, required for delivery |
| `status` | see state machine |
| `statusHistory` | `[{ status, at, byKind, byId, note }]` |
| `rejectReason` | set on reject |
| `handoverOtp` | 4 digits, generated on `ready`; stored hashed; shown only to the patient |
| `courierId` | set on courier assignment |

`PharmacyStock`: `pharmacyId`, `drug`, `strength`, `barcode`, `quantity`, `batch`, `expiry`, `lowStockThreshold`.

`Delivery`: `orderId`, `courierId`, `status` (`assigned \| accepted \| picked_up \| delivered \| failed`), `lastLocation { lat, lng, accuracy, observedAt }`, `proof { kind: "otp" | "photo", at, mediaId }`.

A Supabase migration in `backend/supabase/migrations/` adds the tables, following the existing migration style.

### 4.3 Order state machine

```
new ──► accepted ──► preparing ──► ready ──► picked_up            (pickup)
                                     └────► out_for_delivery ──► delivered   (delivery)
new ──► rejected
new | accepted | preparing ──► cancelled   (patient or pharmacist)
out_for_delivery ──► delivery_failed ──► ready   (courier reports failure; pharmacy can reassign)
```

One pure function `services/pharmacyOrders.js#transition(order, action, actor)` enforces the allowed transitions and who may perform each one. Every route uses that function. Invalid transitions return HTTP 409 with `{ error }`.

| Action | Allowed actor | From | To |
|---|---|---|---|
| accept | pharmacist of that pharmacy | new | accepted |
| reject | pharmacist | new | rejected |
| start | pharmacist | accepted | preparing |
| ready | pharmacist | preparing | ready (generates OTP) |
| handover | pharmacist, with patient OTP | ready (pickup) | picked_up |
| assign_courier | pharmacist | ready (delivery) | ready, `courierId` set, Delivery `assigned` |
| courier_pickup | assigned courier | ready (delivery) | out_for_delivery |
| deliver | assigned courier, with OTP or photo | out_for_delivery | delivered |
| fail | assigned courier | out_for_delivery | delivery_failed |
| cancel | patient or pharmacist | new, accepted, preparing | cancelled |

Stock: `ready` decrements matching stock rows by item quantity. Missing stock does not block the order; it shows a warning to the pharmacist.

### 4.4 Routes

Clinician (`requireAuth`):

- `POST /api/prescriptions` — create for a patient.
- `GET /api/prescriptions?patientId=` — list.
- `PATCH /api/prescriptions/:id` — cancel.
- `GET /api/pharmacies` — list active pharmacies (for the Prescribe panel).

Patient (patient token, own data only, same guard as existing `/api/patient-app/:patientId/*` routes):

- `GET /api/patient-app/:patientId/prescriptions`
- `GET /api/patient-app/:patientId/pharmacies?lat=&lng=` — sorted by distance.
- `POST /api/patient-app/:patientId/orders` — `{ source, pharmacyId, fulfilment, deliveryAddress? }`
- `GET /api/patient-app/:patientId/orders`
- `GET /api/patient-app/:patientId/orders/:id` — includes status history, handover OTP when ready, and courier `lastLocation` only while `out_for_delivery`.
- `POST /api/patient-app/:patientId/orders/:id/cancel`

Refill link: `PATCH /api/reminders/:id` with `refillRequestedAt` keeps its current behaviour. A new optional body `{ refillPharmacyId, fulfilment, deliveryAddress }` on the same request also creates a `PharmacyOrder` with `source.type = "refill"`.

Pharmacist (`requirePharmacist`, scoped to `req.staff.pharmacyIds`):

- `GET /api/pharmacy/orders?pharmacyId=&status=`
- `GET /api/pharmacy/orders/:id`
- `POST /api/pharmacy/orders/:id/actions` — `{ action, reason?, otp?, courierId? }`
- `GET /api/pharmacy/couriers?pharmacyId=`
- `GET|POST|PATCH /api/pharmacy/stock` — list, add, adjust; lookup by `barcode`.

Courier (`requireCourier`, only own deliveries):

- `GET /api/courier/deliveries?status=`
- `GET /api/courier/deliveries/:id` — pharmacy and patient address, patient first name only.
- `POST /api/courier/deliveries/:id/accept`
- `POST /api/courier/deliveries/:id/actions` — `{ action: "pickup" | "deliver" | "fail", otp?, photoMediaId?, reason? }`
- `POST /api/courier/deliveries/:id/location` — `{ lat, lng, accuracy, observedAt }`; older fixes ignored, matching the crew tracking rule.

### 4.5 Privacy rules

- Couriers see patient first name, delivery address and phone only for their active deliveries. No clinical data.
- Pharmacists see order items and prescribing doctor name, not readings, imaging or chat.
- The patient sees courier location only while their order is `out_for_delivery`.
- Handover OTP is hashed at rest and checked in constant time.

## 5. Clinician web

`medicluster/frontend/src/pages/PatientPage.jsx` gets a Prescribe panel:

- Item rows: drug, strength, form, dose, frequency, duration, quantity, instructions; add/remove rows.
- Optional preferred pharmacy (dropdown from `GET /api/pharmacies`).
- List of this patient's prescriptions with status; cancel action.
- API calls through the existing `api/apiClient.js`.
- Follows the existing workspace card styles.

## 6. Native apps

All apps share: login screen, session persistence, 401 handling (back to login), loading/empty/error states, pull-to-refresh, 5-second polling on live screens only while visible.

### 6.1 Pharmacy app

- Login: email + password; choose pharmacy if staff has several.
- Order queue: tabs New, Preparing, Ready, Out for delivery. Card shows patient first name, item count, pickup/delivery, waiting time.
- Order detail: items with stock status, prescribing doctor, history. Buttons follow the state machine (Accept, Reject with reason, Start, Mark ready, Assign courier, Enter patient OTP for pickup).
- Stock: search list, low-stock and near-expiry (30 days) flags, add/adjust, barcode scan with CameraX + ML Kit.
- Profile: pharmacy details, logout.

### 6.2 Courier app

- Login: phone + PIN.
- Jobs: assigned deliveries; Accept.
- Active delivery: osmdroid map with pharmacy and patient markers; Picked up, Navigate (Google Maps intent with destination), Delivered, Report failure.
- Foreground location service runs only while a delivery is `accepted`, `picked_up` or out for delivery. It shows a persistent notification and posts fixes every 10 seconds or 25 metres.
- Proof of delivery: patient OTP entry; photo fallback (upload through the existing media storage).
- History: completed deliveries.

### 6.3 Patient app

Native rewrite of the current web patient app. Source of truth for behaviour and API calls: `medicluster/frontend/src/patient-app/` (`featuresApi.js`, screens) and `medicluster/patient-android/` (reminder alarms).

- Login: phone OTP, email OTP, Google sign-in via Custom Tabs and the existing `/api/patient-auth/google/*` exchange flow.
- Today, Health, Log reading (with existing offline queue behaviour), Visits (appointments), Reports (documents), Profile.
- CliniQ: chat screen using `POST /api/cliniq/chat` and actions, same request shape as `CliniqScreen.jsx`.
- Emergency: SOS, location updates, live ambulance tracking map (existing emergency routes).
- Reminders: port `ReminderStore`, `ReminderSchedule`, `ReminderAlarms`, `ReminderReceiver` from Java to Kotlin with their tests.
- New Pharmacy tab: my prescriptions; order (choose pharmacy sorted by distance, pickup/delivery, address); orders list; order detail with status timeline, handover OTP, live courier map while out for delivery; cancel.

### 6.4 Crew app

Native rewrite of the driver flow. Source of truth: `ambulance-dispatch/frontend/dispatcher-dashboard/src/pages/DriverLoginPage.jsx`, `DriverApp.jsx`, and `services/driverSession.js`, `crewAssignment.js`, `crewLocation.js`, `apiClient.js`, `supabase.js`.

- Login: employee ID + PIN, same backend call, then Supabase session via supabase-kt.
- Assignment: full-screen ring with sound and vibration when an incident is assigned (Supabase realtime on `ambulances`/`incidents`, same filters as the web app).
- Mission: incident map, navigate intent, status steps (en route, on scene, transporting, at hospital, done) with the same table updates as `DriverApp.jsx`.
- GPS: foreground location service during a mission, through the same authenticated dispatch API and throttling rules as `crewLocation.js`.
- History.

## 7. Error handling

- Network: one shared `ApiResult` type (`Success`, `HttpError(code, message)`, `NetworkError`). Screens show a retry state; no crash on offline.
- 401: clear the token and return to login.
- 409 on order actions: refresh the order and show the server message.
- Location permission denied: the courier and crew apps block the active job screen with an explanation and a settings button. No simulated positions.
- Camera permission denied: the pharmacy app falls back to manual barcode entry.

## 8. Testing and verification

### 8.1 Automated

- Backend: unit tests for the state machine (every allowed and forbidden transition), auth kinds (pharmacy/courier tokens rejected by clinician routes and the reverse), route tests for each endpoint, privacy filters. The existing backend suite must stay green.
- Clinician web: component test for the Prescribe panel; existing frontend tests stay green; production build passes.
- Native: unit tests per module (ViewModels with fake repositories, API client with MockWebServer, reminder schedule logic, location throttling). `gradle test lint assembleDebug` passes in Docker for every module.

### 8.2 Device checks (user's phone over USB)

For each app after its wave:

1. `adb install -r` the debug APK.
2. `adb reverse tcp:5000 tcp:5000` to reach the local backend.
3. Drive the main flow with `adb shell input` and capture `adb exec-out screencap` screenshots.
4. Read `adb logcat` for crashes and ANRs.
5. Check permissions on hardware: location (courier, crew, patient emergency), camera (pharmacy), exact alarms and notifications (patient reminders).

### 8.3 End-to-end chain

After the patient and courier apps pass, on the local backend with seeded test accounts and synthetic data:

1. A doctor creates a prescription in the clinician web.
2. The patient app orders it for delivery.
3. The pharmacy app accepts it, starts it, marks it ready and assigns the courier.
4. The courier app accepts it, picks it up and shares GPS. The patient app shows the courier moving.
5. The courier enters the patient's OTP. The patient app shows "delivered".
6. Repeat with pickup and with a refill from a reminder.

Only one phone is available, so the pharmacy and courier steps can run on the phone in turn, or the pharmacist steps run through the API with `curl`. Both are acceptable.

## 9. Execution model

Work runs as agy agents in a Herdr session. The orchestrator (Claude) must run inside Herdr (`HERDR_ENV=1`). The user starts `herdr` and runs Claude in its first pane before execution begins.

- Workspace `pharmacy-native`; one git worktree per agent via `herdr worktree create`, branched from the current branch.
- All agents: `herdr agent start <name> --kind agy -- --model gemini-3.8-flash-high`.
- Tasks are small and explicit, because Flash needs tighter instructions than larger models. Each task names files, the interface to follow, and the test command.

| Wave | Agents (parallel) | Depends on |
|---|---|---|
| 1 | `backend` (backend API), `core` (Gradle project, core modules, Docker image) | — |
| 2 | `pharmacy` (app-pharmacy), `web` (Prescribe panel) | wave 1 |
| 3 | `patient` (app-patient), `courier` (app-courier) | wave 1, 2 |
| 4 | `crew` (app-crew) | wave 1 (core) |

A `build` shell pane runs Docker builds and adb commands.

After each agent's task:

1. The orchestrator re-runs the tests itself.
2. The orchestrator reviews the diff against this spec.
3. Device check (section 8.2) for app work.
4. Failures go back to the same agent with the failing output.
5. Merge into the integration branch only after the checks pass, one worktree at a time.

Approval dialogs from agents (`blocked` state) go to the user. No agent pushes, deploys, touches signing keys or writes to production data.

## 10. Risks

- **Flash model quality.** Mitigation: small tasks, strict re-verification, interface contracts in the plan.
- **Native patient app duplicates web features.** Every patient change after this ships twice. Accepted by the user.
- **Disk space (26 GB free).** The Docker Android image plus Gradle caches need about 8–10 GB. Clean old build output in the repo first if space runs low.
- **One test phone.** End-to-end steps across roles run in turn on one device, or through the API.
- **Crew realtime parity.** The crew app must match the web app's Supabase filters exactly, or assignments can be missed. The crew task includes a side-by-side check with the web driver app.
