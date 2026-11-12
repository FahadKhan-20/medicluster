import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssignmentWatcher} from '../src/services/crewAssignment.js';

const flush = () => new Promise(setImmediate);
const incident = (id, extra = {}) => ({id, status: 'ASSIGNED', assigned_ambulance_id: 'own-unit', incident_type: 'CARDIAC', location_lat: 12.97, location_lng: 77.59, ...extra});

test('assignment saved on the crew ambulance row rings the crew once, with no tab broadcast', async () => {
  const calls = [], fetched = [];
  const w = createAssignmentWatcher({fetchIncident: async id => { fetched.push(id); return incident(id); }, onCall: c => calls.push(c)});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-1'});
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'INC-1');
  assert.equal(calls[0]._isAssignment, true);
  assert.equal(calls[0].ambulance.id, 'own-unit');
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-1'});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-1'});
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(fetched, ['INC-1']);
});

test('incidents for another unit, or already past assignment, never ring', async () => {
  const calls = [];
  const rows = {'INC-2': incident('INC-2', {assigned_ambulance_id: 'other-unit'}), 'INC-3': incident('INC-3', {status: 'EN_ROUTE_TO_SCENE'})};
  const w = createAssignmentWatcher({fetchIncident: async id => rows[id], onCall: c => calls.push(c)});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-2'}); await flush();
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-3'}); await flush();
  w.update({vehicleId: null, assignedIncidentId: 'INC-4'}); await flush();
  assert.equal(calls.length, 0);
});

test('a failed read retries on the next update and a replaced assignment drops its stale reply', async () => {
  const calls = [];
  let fail = true, release;
  const w = createAssignmentWatcher({
    fetchIncident: id => {
      if (id === 'SLOW') return new Promise(r => { release = () => r(incident('SLOW')); });
      if (fail) return Promise.reject(new Error('offline'));
      return Promise.resolve(incident(id));
    },
    onCall: c => calls.push(c),
  });
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-5'}); await flush();
  assert.equal(calls.length, 0);
  fail = false;
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-5'}); await flush();
  assert.equal(calls.length, 1);

  w.update({vehicleId: 'own-unit', assignedIncidentId: 'SLOW'});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-6'}); await flush();
  release(); await flush();
  assert.deepEqual(calls.map(c => c.id), ['INC-5', 'INC-6']);
});

test('the call already on screen does not ring again, and a cleared then repeated assignment rings', async () => {
  const calls = [];
  const w = createAssignmentWatcher({fetchIncident: async id => incident(id), onCall: c => calls.push(c)});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-7', activeIncidentId: 'INC-7'}); await flush();
  assert.equal(calls.length, 0);
  w.update({vehicleId: 'own-unit', assignedIncidentId: null}); await flush();
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-7'}); await flush();
  assert.equal(calls.length, 1);
  w.stop();
  w.update({vehicleId: 'own-unit', assignedIncidentId: null});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-8'}); await flush();
  assert.equal(calls.length, 1);
});

test('an assignment the crew could not take yet rings once the crew is free', async () => {
  const calls = [];
  let free = false;
  const w = createAssignmentWatcher({fetchIncident: async id => incident(id), onCall: c => { if (!free) return false; calls.push(c); return true; }});
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-9'}); await flush();
  assert.equal(calls.length, 0);
  free = true;
  w.update({vehicleId: 'own-unit', assignedIncidentId: 'INC-9'}); await flush();
  assert.deepEqual(calls.map(c => c.id), ['INC-9']);
});
