# Reminders & Missed Doses Workflow Implementation Report

## Summary
Implemented the medication reminders and missed doses workflow for MediCluster `agent-core` and the backend notification endpoint in `medicluster/backend`.

### What Was Built
1. **Missed Dose Detection & Workflow (`agent-core/src/workflows/reminders.ts`)**:
   - `findMissedDoses`: Implements missed dose identification mirroring `missedDoseAlerts` in `alertRoutes.js` (30-minute grace period, 24-hour lookback, weekly weekday check, `as-needed` skipping, and `doseLog` confirmation check).
   - `RemindersWorkflow`: Follows the exact safety and architectural pattern of `loop.ts`:
     - Builds event with ID format `dose:${reminderId}:${date}:${time}`.
     - Logs each lifecycle step in the immutable audit trail (`Audit`).
     - Uses Gemini via `REMINDER_STATE_PROMPT` to extract fact-only state.
     - Enforces code-owned facts over model outputs.
     - Evaluates Jev decision questions (`REMINDER_JEV_QUESTIONS`: `notify_patient`, `escalate_alert`, `ignore`).
     - Respects safety `Gate` with policy group `reminders: auto`, threshold `0.9`, kill-switch recheck, idempotency deduplication, and group rate limiting.
     - Prevents execution of treatment actions (`prescribe`, `dose`, `diagnose`) via Gate review routing.
     - LLM-assisted tool argument generation (`REMINDER_ARGS_PROMPT`) constrained by strict JSON schemas.
     - Handles real-time rows (`handleRealtimeRow`), individual reminders (`handleReminderDoc`), and periodic scheduled checks (`checkAll`, `startPeriodic`).
     - `registerRemindersWorkflow`: Factory helper to wire and register the workflow in `main.ts`.

2. **Reminder Tools (`agent-core/src/tools/reminders.ts`)**:
   - `reminders.notify`: Calls `POST /api/reminders/:id/notify` with schema validation (`reminder_id`, `patient_id`, `date`, `time`, `message`, `audit_id`).
   - `alerts.create` (`reminderAlertTool`): Escalates missed dose alerts to `POST /api/alerts/agent` under policy group `reminders`.
   - `toolForReminderAction`: Dispatches decided actions to corresponding tools.

3. **Backend Agent-Only Reminder Notification Endpoint (`medicluster/backend`)**:
   - Model `medicluster/backend/models/ReminderNotification.js`: Stores notification records indexed by `reminderId` and `patientId`.
   - Routes `POST /api/reminders/:id/notify` and `POST /api/reminders/notify` in `medicluster/backend/routes/reminderRoutes.js`:
     - Protected by `requireAuth` and restricted to agent tokens (`req.agent === true`).
     - Validates payload and confirms reminder existence.
     - Idempotently creates or updates the notification record without touching dose logs, pill counts, times, or prescription parameters ("Never changes doses").
   - Added `POST /api/reminders/:id/notify` and `POST /api/reminders/notify` to `AGENT_ROUTES` in `medicluster/backend/middleware/auth.js`.

4. **Configuration & Wiring**:
   - `agent-core/policy.yaml`: Added `reminders: auto` group policy.
   - `agent-core/src/main.ts`: Added registration line for `registerRemindersWorkflow`.

## Files Created & Modified
- `agent-core/src/workflows/reminders.ts` (new)
- `agent-core/src/tools/reminders.ts` (new)
- `agent-core/tests/reminders.test.ts` (new)
- `medicluster/backend/models/ReminderNotification.js` (new)
- `medicluster/backend/tests/reminderNotify.test.js` (new)
- `agent-core/policy.yaml` (modified - added `reminders: auto`)
- `agent-core/src/main.ts` (modified - imported and registered `registerRemindersWorkflow`)
- `medicluster/backend/middleware/auth.js` (modified - appended reminder notify routes to `AGENT_ROUTES`)
- `medicluster/backend/routes/reminderRoutes.js` (modified - added agent-only notify route)

## Test Output Summary
- **Agent Core (`agent-core`)**:
  - `npx vitest run`: 11 test files passed, 167 tests passed (including 24 comprehensive tests in `tests/reminders.test.ts`).
  - `npx tsc --noEmit -p .`: 0 TypeScript compiler errors.
- **Backend (`medicluster/backend`)**:
  - `node --test tests/reminderNotify.test.js tests/agentAccess.test.js`: 12 tests passed, 0 failed (testing agent notify route creation, idempotency, auth protection, validation, and route allowlisting).

## Left Undone / Notes
- None. All requirements implemented and verified with passing tests.
