# CrewSync Implementation Report (`crewsync`)

## Summary
The `crewsync` bug fix task resolves discrepancies between live Supabase state and the Crew, Dispatcher, and Patient applications:
1. **Real Tile Map in Crew App**: Replaced placeholder SVG grid with MapLibre GL OSM raster map (`DriverMap.jsx`) rendering the vehicle's live GPS position pin, assigned incident pin, hospital destination pin, and real-time turn-by-turn route line (OSRM with geodesic straight-line fallback).
2. **Authoritative Mission State Derivation**: Crew interface (`DriverApp.jsx` and `DriverInterface.jsx`) now derives mission lifecycle directly from authoritative Supabase `ambulances` and `incidents` records (initial load + Supabase postgres changes realtime subscriptions on both tables + auto-refetch on window focus/online reconnection). Crews can progress and complete missions (such as completing handover when at hospital to set incident to `RESOLVED` and ambulance to `AVAILABLE`).
3. **Dispatcher Broadcast Isolation & Stale Indicators**: Removed hardcoded `Alpha-1` / `AMB-001` match clause from `useData.js` so broadcast pings update only their matching ambulance. Live markers in `DispatchMap.jsx` update popups on Postgres UPDATEs. Units panel and map popups display dynamic "last ping Xs ago" and highlight units stale after >60 seconds.
4. **Patient App Live Crew Tracking**: `EmergencyScreen.jsx` moves the tracking pin with crew GPS fixes via `patientCad.track`, displaying "last update Xs ago" and `(stale >60s)` label while enforcing that closed emergencies never expose subsequent crew locations.
5. **Unified Status Labels**: Created shared `statusLabels.js` mapping standard CAD lifecycle statuses across dispatcher, crew, and patient apps.

---

## File Changes & Architectural Details

### 1. Unified Status Definitions
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/services/statusLabels.js`:
  - Standardized status constants: `ASSIGNED`, `EN_ROUTE_TO_SCENE`, `ON_SCENE`, `TRANSPORTING_TO_HOSPITAL`, `ARRIVED_AT_HOSPITAL`, `AVAILABLE`, `RESOLVED`, `CANCELLED`.
  - Utility `statusToStage(status)` mapping CAD database statuses to sequential crew steps (1..4).
  - Utility `getStatusLabel(status)` returning clean human-readable labels.
- `medicluster/frontend/src/patient-app/statusLabels.js`:
  - Mirrored standard status labels for patient emergency tracking UI.

### 2. Crew App & Driver Map
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/components/DriverMap.jsx`:
  - Full MapLibre GL implementation with OSM raster tiles (`STREET_MAP_STYLE`).
  - Rendered DOM markers with `data-testid="crew-map-pin"`, `data-testid="incident-map-pin"`, `data-testid="hospital-map-pin"`.
  - Vehicle heading rotator puck and coordinate tracking.
  - OSRM route fetcher with fallback line string rendering.
  - Headless/WebGL-safe fallback container ensuring stability in CI browser environments.
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/pages/DriverApp.jsx`:
  - Integrated `DriverMap` replacing the previous `MapPanel` SVG mock.
  - Implemented `fetchAuthoritativeMission(unitId)` querying `ambulances` and assigned `incidents` directly from Supabase REST.
  - Added Supabase realtime channels subscribing to `postgres_changes` on both `ambulances` (`id=eq.${unitId}`) and `incidents`.
  - Attached `window.addEventListener('focus')` and `window.addEventListener('online')` to re-synchronize state.
  - Added handover completion action allowing crews arriving at hospital to set incident status to `RESOLVED` and ambulance status to `AVAILABLE`.
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/pages/DriverInterface.jsx`:
  - Replaced hardcoded fallback unit coordinates with dynamic authoritative state.
  - Derived mission lifecycle from database records.

### 3. Dispatcher Dashboard Fixes
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/hooks/useData.js`:
  - Removed `a.call_sign === 'Alpha-1' || a.id === 'AMB-001'` fallback match from `handleBroadcastLocation` and the Supabase broadcast listener. Broadcast updates now strictly match `a.id === targetId || a.vehicle_number === targetId`.
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/map/markers.js`:
  - Updated `STALE_AFTER_MS` from 120,000ms to 60,000ms.
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/components/UnitsPanel.jsx`:
  - Added live ticking timer updating "last ping Xs ago" every 10 seconds.
  - Highlighted stale badge `STALE >60s` when `last_ping` exceeds 60 seconds.
- `ambulance-dispatch/frontend/dispatcher-dashboard/src/components/DispatchMap.jsx`:
  - Generated dynamic popup content containing driver name, speed, status, "last ping Xs ago", and `STALE >60s` warning.
  - Updated marker popups on `postgres_changes` UPDATE when markers already exist on the map.

### 4. Patient App Emergency Tracking
- `medicluster/frontend/src/patient-app/screens/EmergencyScreen.jsx`:
  - Updated stale indicator threshold to 60s.
  - Displayed "last update Xs ago" and `(stale >60s)` badge for crew telemetry.
  - Retained strict privacy rule: closed emergencies immediately hide crew GPS tracking pins.

### 5. Configuration & Tests
- `ambulance-dispatch/frontend/dispatcher-dashboard/vite.config.js`:
  - Configured `server.fs.strict: false` to allow serving MapLibre GL worker modules in development and testing environments.
- `medicluster/frontend/playwright.config.js`:
  - Added `dispatcher-dashboard` dev server on port 5174 alongside `medicluster-frontend` dev server on port 3000.
- `ambulance-dispatch/frontend/dispatcher-dashboard/tests/statusDerivation.test.js`:
  - Verified `statusToStage` and `getStatusLabel` across all lifecycle stages.
- `ambulance-dispatch/frontend/dispatcher-dashboard/tests/broadcastFix.test.js`:
  - Verified `handleBroadcastLocation` isolation: broadcast updates to one unit never mutate unrelated units (`Alpha-1` / `AMB-001`).
- `medicluster/frontend/tests/browser/crew-tracking.spec.js`:
  - Extended browser end-to-end suite with tests verifying:
    - Authoritative mission state derivation from database row (`AMB-007` at `ARRIVED_AT_HOSPITAL`), hospital destination rendering, map display, and handover completion returning unit to standby.
    - Live MapLibre crew marker following continuous GPS updates.

---

## Test Verification Results

| Package | Test Command | Result |
| :--- | :--- | :--- |
| `ambulance-dispatch/frontend/dispatcher-dashboard` | `npm run build && npm test` | **37 passed, 0 failed** (Build OK) |
| `ambulance-dispatch/backend/api` | `npm test` | **21 passed, 0 failed** |
| `medicluster/frontend` | `npm run build && npm test` | **65 passed, 0 failed** (Build OK) |
| `medicluster/frontend` (Playwright) | `npx playwright test tests/browser/crew-tracking.spec.js` | **4 passed, 0 failed** (E2E browser tests) |
| `medicluster/backend` | `npm test` | **258 passed, 0 failed** |

---

## Decisions & Live Database Constraints
- Real Supabase database data was completely untouched; no manual row edits were performed against the production environment.
- Docker containers and git remote pushes were avoided in adherence with instructions.
- All work was performed strictly within `/home/vinay/mc2-crewsync` on branch `par2/crewsync`.
