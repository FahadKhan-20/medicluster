import test from 'node:test';
import assert from 'node:assert/strict';

// Replicates the handleBroadcastLocation logic from hooks/useData.js
function applyBroadcastLocation(prevAmbulances, data) {
  if (!data) return prevAmbulances;
  const targetId = data.ambulance_id || data.id;
  if (!targetId) return prevAmbulances;
  return prevAmbulances.map(a =>
    a.id === targetId
      ? { ...a, latitude: data.latitude, longitude: data.longitude, speed: data.speed ?? a.speed, heading: data.heading ?? a.heading, last_ping: data.last_ping || a.last_ping }
      : a
  );
}

test('broadcast location update only moves the matching vehicle and leaves Alpha-1 / AMB-001 untouched', () => {
  const ambulances = [
    { id: 'AMB-001', call_sign: 'Alpha-1', latitude: 12.9716, longitude: 77.5946, speed: 0, last_ping: '2026-11-13T00:00:00Z' },
    { id: 'AMB-007', call_sign: 'Bravo-7', latitude: 12.9200, longitude: 77.6100, speed: 0, last_ping: '2026-11-13T00:00:00Z' },
    { id: 'AMB-009', call_sign: 'Delta-9', latitude: 12.9500, longitude: 77.6500, speed: 0, last_ping: '2026-11-13T00:00:00Z' },
  ];

  // AMB-007 reports a fresh GPS fix
  const updateData = {
    ambulance_id: 'AMB-007',
    latitude: 12.9350,
    longitude: 77.6250,
    speed: 48,
    heading: 90,
    last_ping: '2026-11-13T00:05:00Z',
  };

  const result = applyBroadcastLocation(ambulances, updateData);

  // AMB-007 was updated
  const amb7 = result.find(a => a.id === 'AMB-007');
  assert.equal(amb7.latitude, 12.9350);
  assert.equal(amb7.longitude, 77.6250);
  assert.equal(amb7.speed, 48);
  assert.equal(amb7.heading, 90);
  assert.equal(amb7.last_ping, '2026-11-13T00:05:00Z');

  // AMB-001 (Alpha-1) was NOT moved or overwritten
  const amb1 = result.find(a => a.id === 'AMB-001');
  assert.equal(amb1.latitude, 12.9716);
  assert.equal(amb1.longitude, 77.5946);
  assert.equal(amb1.speed, 0);
  assert.equal(amb1.last_ping, '2026-11-13T00:00:00Z');

  // AMB-009 was NOT moved
  const amb9 = result.find(a => a.id === 'AMB-009');
  assert.equal(amb9.latitude, 12.9500);
});

test('broadcast location update ignores payloads with missing or invalid target id', () => {
  const ambulances = [
    { id: 'AMB-001', call_sign: 'Alpha-1', latitude: 12.9716, longitude: 77.5946 },
  ];

  assert.deepEqual(applyBroadcastLocation(ambulances, null), ambulances);
  assert.deepEqual(applyBroadcastLocation(ambulances, {}), ambulances);
  assert.deepEqual(applyBroadcastLocation(ambulances, { speed: 50 }), ambulances);
});
