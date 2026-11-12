# Pharmacy Workflow Implementation Report

**Worktree**: `/home/vinay/mc3-rxagent`  
**Branch**: `par3/rxagent`  
**Task Specification**: `/home/vinay/medicluster-agent-core/.superpowers/sdd/parallel/t-rxagent.md`  
**Design Reference**: `docs/superpowers/specs/2026-11-11-native-pharmacy-suite-design.md` sections 4.1–4.5

---

## 1. Executive Summary

A comprehensive pharmacy workflow (`PharmacyWorkflow`) and corresponding pharmacy tools (`src/tools/pharmacy.ts`) have been added to `agent-core`. The workflow continuously monitors pharmacy operations every 5 minutes (+ on start), evaluates conditions using Gemini fact extraction and Jev probabilistic judgment, gates execution against the `"pharmacy"` policy group, and audits every step append-only.

Three primary operations are handled:
1. **Low Stock Monitoring**: Checks `GET /api/pharmacy/agent/stock-low`, uses Jev to evaluate urgency and necessity, and alerts the pharmacy via `POST /api/alerts/agent` (severity mapped from Jev urgency: `routine` -> `WARNING`, `urgent` -> `HIGH`, `critical` -> `CRITICAL`).
2. **Stuck Orders Detection**: Checks `GET /api/pharmacy/agent/stuck-orders` for orders stuck in any state beyond SLA, using Jev to alert the pharmacy and clinician via `POST /api/alerts/agent`.
3. **Missed-Dose Refill Suggestions**: Detects missed doses for medications where pills or refills are exhausted and no active pharmacy order exists. Submits a suggestion to `POST /api/pharmacy/agent/refill-suggestion` for clinician confirmation. Per hard clinical rules, treatment actions stay suggest-only—it never autonomously creates a prescription or order.

---

## 2. Changes Made

### 2.1 Policy Configuration (`agent-core/policy.yaml`)
- Added policy group `pharmacy: auto` with existing rate limits and 0.90 confidence threshold.

### 2.2 Pharmacy Tools & Client Helpers (`agent-core/src/tools/pharmacy.ts`)
- Implemented and exported tools with strict `ToolSchema` validation:
  - `pharmacy.stock_low`: queries `GET /api/pharmacy/agent/stock-low`.
  - `pharmacy.stuck_orders`: queries `GET /api/pharmacy/agent/stuck-orders`.
  - `pharmacy.refill_suggestion`: validates `patientId`, `reminderId`, `medicationName`, `dosage`, `reason`, `auditId` and posts to `/api/pharmacy/agent/refill-suggestion`.
  - `pharmacy.alert`: validates alert schema and dispatches to `/api/alerts/agent`.
- Exported typed helpers: `fetchLowStock`, `fetchStuckOrders`, `postRefillSuggestion`, `postPharmacyAlert`.

### 2.3 Pharmacy Workflow Engine (`agent-core/src/workflows/pharmacy.ts`)
- Implemented `PharmacyWorkflow`:
  - **Fact Extraction**: Prompts Gemini for fact-only representations (`PHARMACY_STOCK_STATE_PROMPT`, `PHARMACY_ORDER_STATE_PROMPT`, `PHARMACY_REFILL_STATE_PROMPT`), strictly overridden by code-verified data.
  - **Jev Decisions**: Configured question sets (`STOCK_LOW_JEV_QUESTIONS`, `STUCK_ORDERS_JEV_QUESTIONS`, `REFILL_SUGGESTION_JEV_QUESTIONS`) evaluating action, urgency scoring, and noul safety score.
  - **Gate Checks**: Evaluates group `"pharmacy"`, verifies confidence thresholds, checks duplicate execution via daily idempotency keys, and respects kill switches.
  - **Daily Idempotency**: Keys formatted per item + day (`pharmacy:stock:${pharmacyId}:${drug}:${dateKey}`, `pharmacy:order:${orderId}:${dateKey}`, `pharmacy:refill:${reminderId}:${patientId}:${dateKey}`) to prevent duplicate actions.
  - **Kill Switch & Resilience**: Checks `state.isStopped()`, enqueues blocked events to `state.enqueue`, and provides `retryPending()` to drain and process queued events when resumed.
  - **Periodic Polling**: Runs every 5 minutes (`startPeriodic(300000)`), executes immediately on start, and terminates cleanly via `stopPeriodic()`.
  - **Full Audit Trail**: Append-only auditing for all operations recording `state`, `jev`, `gate`, `args`, and `tool` steps.

### 2.4 System Wiring (`agent-core/src/main.ts`)
- Registered `pharmacyWorkflow` on startup with full dependencies.
- Added `pharmacyWorkflow.retryPending()` to the global retry loop.
- Added `pharmacyWorkflow.stopPeriodic()` to the graceful shutdown handler.

### 2.5 Console Agent List (`agent-core/src/console/index.html`)
- Updated agent counter in the navigation sidebar from 5 to 6.
- Added `"Pharmacy Ops"` link to the sidebar agent hierarchy.
- Added `"Pharmacy Ops"` row in `#viewAgents` with `RX` avatar, status `"Connected"`, and subtitle `"Stock, Stuck Orders & Refills • Jev + Gate"`.

### 2.6 Comprehensive Test Suite (`agent-core/tests/pharmacy.test.ts`)
- Added 11 automated vitest tests verifying:
  - Tool schema validation and backend route invocation for all 4 pharmacy tools.
  - End-to-end low stock evaluation, fact building, Jev alert dispatching, and daily idempotency deduplication.
  - Jev `ignore` handling.
  - Stuck order detection and SLA breach alerting.
  - Missed-dose refill suggestion creation with strict verification that prescriptions and orders are never created.
  - Kill-switch blocking, event queuing, and `retryPending` queue draining.
  - Periodic timer start and cleanup.

---

## 3. Verification & Test Results

1. **Vitest Test Suite**:
   ```
   npx vitest run
   Test Files  24 passed (24)
        Tests  376 passed (376)
   ```
2. **TypeScript Compilation**:
   ```
   npx tsc --noEmit -p .
   (Clean exit, 0 errors)
   ```
3. **Safety & Hard Rules**:
   - Zero real database writes or Docker operations performed.
   - Refill suggestions remain suggest-only for clinicians.
   - Idempotency strictly enforced per item + day.
