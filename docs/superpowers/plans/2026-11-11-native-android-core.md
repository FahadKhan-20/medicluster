# Native Android Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `medicluster/native-android` Gradle project with a Docker build image and the shared `core/*` modules every native app uses, plus a tiny `app-sample` that proves the modules work on a phone.

**Architecture:** One multi-module Gradle project (Kotlin DSL, version catalog). Core modules are Android libraries with no app-specific screens. Apps depend on them and wire them manually (no DI framework).

**Tech Stack:** Kotlin 2.x, Jetpack Compose (BOM) + Material 3, Retrofit + OkHttp + kotlinx.serialization, Coroutines/Flow, AndroidX Security (EncryptedSharedPreferences), Google Play Services Location, osmdroid, JUnit 4, kotlinx-coroutines-test, OkHttp MockWebServer. Build: JDK 17, Gradle 8.11.1, Android SDK 35 inside Docker.

**Spec:** `docs/superpowers/specs/2026-11-11-native-pharmacy-suite-design.md` (sections 3, 7, 8.1)

## Global Constraints

- All files under `medicluster/native-android/`. Do not touch `patient-android/`, `crew-android/` or other folders.
- `minSdk 26`, `targetSdk 35`, `compileSdk 35`, Java/Kotlin JVM target 17.
- Package root `com.medicluster.core.<module>`.
- Every build and test command runs inside Docker: `docker run --rm -v "$PWD":/work -v mc-gradle-cache:/root/.gradle -w /work medicluster-android-build <gradle args>` from `medicluster/native-android`. Alias below as `./dg <args>` (Task 1 creates this script).
- `API_BASE_URL` comes from Gradle property `apiBaseUrl`, default `http://127.0.0.1:5000/`. Debug builds may use cleartext only to `127.0.0.1`; release builds reject `http://`.
- No Google Maps API key; maps use osmdroid with `Configuration.getInstance().userAgentValue = "MediCluster/<appId>"`.
- No simulated GPS positions anywhere.
- Commit after each task (`feat(native): ...`). Do not push.

## Review Focus

- Phone offline when a screen loads: API returns `ApiResult.NetworkError`, no crash. Test in Task 3.
- Server returns 401 mid-session: token cleared, `SessionState` flips to `SignedOut`. Test in Tasks 3 and 4.
- Server returns non-JSON error body (HTML 502 from Render): `HttpError` with a generic message, no serialization crash. Test in Task 3.
- Location permission revoked while the foreground service runs: service stops itself and reports `LocationStatus.PermissionDenied`. Test in Task 5.
- Two GPS fixes inside 10 s and 25 m: second is dropped by the throttle. Test in Task 5.

---

### Task 1: Gradle project and Docker build image

**Files:**
- Create: `native-android/settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`
- Create: `native-android/docker/Dockerfile`, `native-android/dg` (executable shell wrapper)
- Create: `native-android/.gitignore` (`build/`, `.gradle/`, `local.properties`, `*.apk` outside `review/`)
- Create: `native-android/README.md` (how to build, install with adb, set `apiBaseUrl`)

**Interfaces:**
- Produces: modules declared in `settings.gradle.kts`: `:core:model`, `:core:network`, `:core:auth`, `:core:location`, `:core:maps`, `:core:ui`, `:app-sample`. Later plans add `:app-pharmacy`, `:app-courier`, `:app-patient`, `:app-crew`.
- Produces: `./dg <gradle args>` builds image `medicluster-android-build` if missing, then runs `gradle --no-daemon <args>` in the container.
- Dockerfile: `eclipse-temurin:17-jdk`, Gradle 8.11.1, Android cmdline-tools, `platforms;android-35`, `build-tools;35.0.0`, licenses accepted.

- [ ] **Step 1: Write the files.** Each core module gets an empty `build.gradle.kts` (Android library, namespace `com.medicluster.core.<name>`) and a placeholder `src/main/AndroidManifest.xml`.
- [ ] **Step 2: Run** `./dg projects` — expect the 7 modules listed.
- [ ] **Step 3: Run** `./dg help` twice; second run must reuse the image and Gradle cache volume (no re-download).
- [ ] **Step 4: Check disk** `df -h /` — record free space in the commit message body.
- [ ] **Step 5: Commit** `feat(native): add Gradle project and Docker build image`.

### Task 2: `core:model` and `core:ui`

**Files:**
- Create: `core/model/src/main/kotlin/com/medicluster/core/model/{Pharmacy.kt,Prescription.kt,PharmacyOrder.kt,PharmacyStock.kt,Delivery.kt,Staff.kt,GeoPoint.kt}`
- Create: `core/ui/src/main/kotlin/com/medicluster/core/ui/{Theme.kt,StatusChip.kt,StatusTimeline.kt,ScreenState.kt}`
- Test: `core/model/src/test/kotlin/com/medicluster/core/model/ModelJsonTest.kt`

**Interfaces:**
- Produces (`@Serializable`, field names identical to the backend JSON in spec 4.2; Mongo-style id field is `@SerialName("_id") val id: String`; unknown keys ignored):
  - `Pharmacy(id, name, address, lat: Double, lng: Double, phone, distanceKm: Double? = null)`
  - `PrescriptionItem(drug, strength = "", form = "", dose = "", frequency = "", durationDays: Int? = null, quantity: Int, instructions = "")`, `Prescription(id, patientId, doctorUserId, items, notes = "", status, pharmacyId: String? = null, createdAt: String)`
  - `OrderStatus` enum with `@SerialName` values exactly `new, accepted, preparing, ready, picked_up, out_for_delivery, delivered, delivery_failed, rejected, cancelled`, plus `Unknown` fallback for unseen values
  - `PharmacyOrder(id, patientId, pharmacyId, source: OrderSource, items, fulfilment: String, deliveryAddress: Address? = null, status: OrderStatus, statusHistory: List<StatusEntry>, rejectReason: String? = null, courierId: String? = null, handoverOtp: String? = null, courierLocation: GeoFix? = null)`
  - `StockItem(id, pharmacyId, drug, strength = "", barcode = "", quantity: Int, batch = "", expiry: String? = null, lowStockThreshold: Int = 0)`
  - `Delivery(id, orderId, courierId, status: String, lastLocation: GeoFix? = null)`
  - `Staff(id, name, role: String, pharmacyIds: List<String> = emptyList())`
  - `GeoFix(lat: Double, lng: Double, accuracy: Double? = null, observedAt: String)`
  - `val Json: kotlinx.serialization.json.Json` configured `ignoreUnknownKeys = true, explicitNulls = false, coerceInputValues = true` (exported as `MediJson`)
- Produces (`core:ui`): `MediTheme(content)`; `StatusChip(status: OrderStatus)`; `StatusTimeline(entries: List<StatusEntry>)`; `sealed interface ScreenState<out T> { Loading; Empty; Error(message, retry: () -> Unit); Ready(data: T) }` and composable `ScreenStateHost(state, content)`.

- [ ] **Step 1: Write failing `ModelJsonTest`:** decode a sample order JSON copied from `medicluster/backend/docs/pharmacy-api.md` if present, else from spec 4.2 field list; unknown status string decodes to `OrderStatus.Unknown`; extra unknown keys ignored; missing optional fields default.
- [ ] **Step 2: Run** `./dg :core:model:test` — FAIL.
- [ ] **Step 3: Implement** models and ui components.
- [ ] **Step 4: Run** `./dg :core:model:test :core:ui:assembleDebug` — PASS.
- [ ] **Step 5: Commit** `feat(native): add shared models and UI kit`.

### Task 3: `core:network`

**Files:**
- Create: `core/network/src/main/kotlin/com/medicluster/core/network/{ApiResult.kt,ApiClient.kt,AuthInterceptor.kt,Polling.kt}`
- Test: `core/network/src/test/kotlin/com/medicluster/core/network/{ApiClientTest.kt,PollingTest.kt}`

**Interfaces:**
- Consumes: `MediJson` (Task 2).
- Produces:
  - `sealed interface ApiResult<out T> { data class Success<T>(val value: T); data class HttpError(val code: Int, val message: String); data object NetworkError }`
  - `suspend fun <T> apiCall(block: suspend () -> T): ApiResult<T>` — maps `HttpException` to `HttpError` (message from JSON `{ "error": "..." }` body, else `"Server error (<code>)"`), `IOException` to `NetworkError`; rethrows `CancellationException`.
  - `class ApiClient(baseUrl: String, tokenProvider: () -> String?, onUnauthorized: () -> Unit)` with `fun <S> create(service: Class<S>): S` (Retrofit + kotlinx.serialization converter + `AuthInterceptor`). Constructor throws `IllegalArgumentException` for an `http://` base URL whose host is not `127.0.0.1` or `localhost`, and for any `http://` URL when `allowCleartext = false` (release).
  - `AuthInterceptor` adds `Authorization: Bearer <token>`; calls `onUnauthorized()` on any 401.
  - `fun <T> pollWhileActive(intervalMs: Long = 5_000, fetch: suspend () -> ApiResult<T>): Flow<ApiResult<T>>` — emits immediately, then every interval; never overlaps requests; stops when the collector cancels.

- [ ] **Step 1: Write failing tests (MockWebServer):** bearer header sent; 401 calls `onUnauthorized` once and returns `HttpError(401, ...)`; `{ "error": "Wrong code" }` 400 → message `"Wrong code"`; HTML 502 body → `"Server error (502)"`; server shut down → `NetworkError`; cleartext guard throws for `http://example.com/`; `pollWhileActive` with a slow fetch never runs two fetches at once (virtual time).
- [ ] **Step 2: Run** `./dg :core:network:test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): add API client and polling`.

### Task 4: `core:auth`

**Files:**
- Create: `core/auth/src/main/kotlin/com/medicluster/core/auth/{TokenStore.kt,SessionManager.kt}`
- Test: `core/auth/src/test/kotlin/com/medicluster/core/auth/SessionManagerTest.kt`

**Interfaces:**
- Produces:
  - `interface TokenStore { fun read(): String?; fun write(token: String?) }`; `class EncryptedTokenStore(context: Context, fileName: String) : TokenStore` (AndroidX Security `EncryptedSharedPreferences`); `class MemoryTokenStore : TokenStore` for tests.
  - `sealed interface SessionState { data object SignedOut; data class SignedIn(val token: String) }`
  - `class SessionManager(store: TokenStore) { val state: StateFlow<SessionState>; fun signIn(token: String); fun signOut(); fun token(): String? }` — `signOut()` is what apps pass to `ApiClient.onUnauthorized`.

- [ ] **Step 1: Write failing tests:** starts `SignedOut` with empty store; starts `SignedIn` when store has a token; `signIn` writes the store and updates state; `signOut` clears both; wiring `ApiClient(onUnauthorized = session::signOut)` against a MockWebServer 401 ends `SignedOut`.
- [ ] **Step 2: Run** `./dg :core:auth:test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): add session and token storage`.

### Task 5: `core:location` and `core:maps`

**Files:**
- Create: `core/location/src/main/kotlin/com/medicluster/core/location/{FixThrottle.kt,LocationStatus.kt,LocationTrackingService.kt}`
- Create: `core/location/src/main/AndroidManifest.xml` (permissions `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`; service with `foregroundServiceType="location"`)
- Create: `core/maps/src/main/kotlin/com/medicluster/core/maps/MediMap.kt`
- Test: `core/location/src/test/kotlin/com/medicluster/core/location/FixThrottleTest.kt`

**Interfaces:**
- Consumes: `GeoFix` (Task 2).
- Produces:
  - `class FixThrottle(minIntervalMs: Long = 10_000, minDistanceM: Double = 25.0) { fun accept(fix: GeoFix, nowMs: Long): Boolean }` — accepts the first fix; afterwards accepts when interval **or** distance threshold is exceeded; rejects fixes with `observedAt` older than the last accepted one.
  - `sealed interface LocationStatus { Idle; Sharing(val last: GeoFix?); PermissionDenied; Error(val message: String) }`
  - `abstract class LocationTrackingService : LifecycleService` — apps subclass it and implement `abstract suspend fun upload(fix: GeoFix): Boolean`. Static `start(context, cls, notificationTitle)` / `stop(context, cls)`. Exposes `companion object { val status: StateFlow<LocationStatus> }`. Uses `FusedLocationProviderClient` high accuracy, 5 s request interval, `FixThrottle` before `upload`, retries only the newest failed fix. Stops itself and sets `PermissionDenied` if permission is missing at start or a `SecurityException` occurs.
  - `@Composable fun MediMap(markers: List<MapMarker>, modifier: Modifier, follow: GeoPoint? = null)` with `data class MapMarker(val id: String, val point: GeoPoint, val label: String, val kind: MarkerKind)` and `enum class MarkerKind { Pharmacy, Patient, Courier, Ambulance, Incident }`.

- [ ] **Step 1: Write failing `FixThrottleTest`:** first fix accepted; second at +5 s / 10 m rejected; at +11 s accepted; at +2 s / 40 m accepted; older `observedAt` rejected.
- [ ] **Step 2: Run** `./dg :core:location:test` — FAIL.
- [ ] **Step 3: Implement** throttle, status, service, map composable.
- [ ] **Step 4: Run** `./dg :core:location:test :core:maps:assembleDebug` — PASS.
- [ ] **Step 5: Commit** `feat(native): add location service and map`.

### Task 6: `app-sample` smoke app and full build

**Files:**
- Create: `app-sample/build.gradle.kts` (applicationId `com.medicluster.sample`, debug only), `app-sample/src/main/AndroidManifest.xml`, `app-sample/src/main/kotlin/com/medicluster/sample/MainActivity.kt`

**Interfaces:**
- Consumes: all core modules.
- Produces: one screen in `MediTheme`: calls `GET /api/health` through `ApiClient` and shows the result in `ScreenStateHost`; shows a `MediMap` with one marker at the seeded test pharmacy (12.9716, 77.5946); a "Share location" button that starts a `LocationTrackingService` subclass whose `upload` only logs the fix (tag `MediSample`) and returns true.

- [ ] **Step 1: Implement** the sample app.
- [ ] **Step 2: Run** `./dg test lint assembleDebug` — every module PASS, lint 0 errors.
- [ ] **Step 3: Device check** (orchestrator runs this, phone on USB): `adb reverse tcp:5000 tcp:5000`; `adb install -r app-sample/build/outputs/apk/debug/app-sample-debug.apk`; launch; screenshot with `adb exec-out screencap -p > review/sample-home.png`; tap Share location, grant permission, walk or wait 30 s; `adb logcat -d -s MediSample` shows real fixes; `adb logcat -d | grep -E "FATAL|ANR"` empty.
- [ ] **Step 4: Commit** `feat(native): add sample app proving core modules`.

---

## Later plans (written after this plan and the backend plan pass)

Each later plan starts from the merged interfaces above and `medicluster/backend/docs/pharmacy-api.md`:

- `2026-11-1x-app-pharmacy.md` and `2026-11-1x-web-prescribe-panel.md` (wave 2)
- `2026-11-1x-app-patient.md` and `2026-11-1x-app-courier.md` (wave 3)
- `2026-11-1x-app-crew.md` (wave 4)
