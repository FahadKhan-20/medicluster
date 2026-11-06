import test from 'node:test';
import assert from 'node:assert/strict';
import {shortIncidentId} from '../src/services/incidentLabel.js';

test('long patient SOS ids shorten to six readable characters', () => {
  assert.equal(shortIncidentId('PAT-2aec69052131f9fbd57f00aa'), '#2AEC69');
  assert.equal(shortIncidentId('PAT-5ba5646fe8d4a45b01d'), '#5BA564');
});
test('short ids stay as they are, empty stays empty', () => {
  assert.equal(shortIncidentId('INC-001'), '#INC-001');
  assert.equal(shortIncidentId('inc-12'), '#INC-12');
  assert.equal(shortIncidentId(''), '');
  assert.equal(shortIncidentId(null), '');
});
test('long ids without a prefix shorten too', () => {
  assert.equal(shortIncidentId('3f2b9c1e-8a7d-4e21-9b0c-1d2e3f4a5b6c'), '#3F2B9C');
});
