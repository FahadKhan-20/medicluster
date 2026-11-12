import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_LABELS, getStatusLabel, statusToStage } from '../src/services/statusLabels.js';

test('statusToStage maps CAD lifecycle statuses to sequential crew stages', () => {
  // Stage 1: En Route to Scene
  assert.equal(statusToStage('ASSIGNED'), 1);
  assert.equal(statusToStage('EN_ROUTE_TO_SCENE'), 1);
  assert.equal(statusToStage('EN_ROUTE'), 1);

  // Stage 2: On Scene
  assert.equal(statusToStage('ON_SCENE'), 2);

  // Stage 3: Transporting
  assert.equal(statusToStage('TRANSPORTING_TO_HOSPITAL'), 3);
  assert.equal(statusToStage('TRANSPORTING'), 3);

  // Stage 4: Arrived at Hospital
  assert.equal(statusToStage('ARRIVED_AT_HOSPITAL'), 4);
  assert.equal(statusToStage('AT_HOSPITAL'), 4);

  // Standby / other statuses fallback to 1
  assert.equal(statusToStage('AVAILABLE'), 1);
  assert.equal(statusToStage('RESOLVED'), 1);
  assert.equal(statusToStage(null), 1);
});

test('getStatusLabel returns human-readable label for CAD statuses', () => {
  assert.equal(getStatusLabel('ASSIGNED'), 'Assigned');
  assert.equal(getStatusLabel('EN_ROUTE_TO_SCENE'), 'En Route');
  assert.equal(getStatusLabel('EN_ROUTE'), 'En Route');
  assert.equal(getStatusLabel('ON_SCENE'), 'On Scene');
  assert.equal(getStatusLabel('TRANSPORTING_TO_HOSPITAL'), 'Transporting');
  assert.equal(getStatusLabel('TRANSPORTING'), 'Transporting');
  assert.equal(getStatusLabel('ARRIVED_AT_HOSPITAL'), 'At Hospital');
  assert.equal(getStatusLabel('AT_HOSPITAL'), 'At Hospital');
  assert.equal(getStatusLabel('AVAILABLE'), 'Available');
  assert.equal(getStatusLabel('RESOLVED'), 'Resolved');
  assert.equal(getStatusLabel('CANCELLED'), 'Cancelled');
  assert.equal(getStatusLabel('UNKNOWN_STAGE'), 'UNKNOWN STAGE');
  assert.equal(getStatusLabel(null), 'Unknown');
});
