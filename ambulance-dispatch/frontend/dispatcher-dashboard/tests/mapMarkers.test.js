import test from 'node:test';
import assert from 'node:assert/strict';
import {ambulanceMarkerHtml, incidentMarkerHtml, hospitalMarkerHtml, incidentGlyph, routeBadgeText} from '../src/map/markers.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = Date.parse('2026-11-06T10:00:00Z');

test('ambulance marker is a custom SVG puck with one compact callsign label and a rotatable heading', () => {
  const html = ambulanceMarkerHtml({id: 'AMB-004', call_sign: 'Delta-4', status: 'EN_ROUTE_TO_SCENE', last_ping: '2026-11-06T09:59:30Z'}, {now: NOW});
  assert.match(html, /<svg[^>]*data-glyph="ambulance"/);
  assert.match(html, /class="[^"]*vehicle-icon-rotator/);
  assert.equal((html.match(/class="[^"]*amb-live-badge/g) || []).length, 1);
  assert.match(html, />Delta-4</);
  assert.doesNotMatch(html, EMOJI);
  assert.doesNotMatch(html, /mk-stale/);
});

test('an ambulance that stopped reporting is marked stale without emoji', () => {
  const html = ambulanceMarkerHtml({id: 'AMB-1', call_sign: 'Alpha-1', status: 'AVAILABLE', last_ping: '2026-11-06T09:50:00Z'}, {now: NOW});
  assert.match(html, /mk-stale/);
  assert.doesNotMatch(html, EMOJI);
});

test('incident pin picks a glyph per type, uses severity colour, and pulses only when critical', () => {
  assert.equal(incidentGlyph('CARDIAC'), 'heart');
  assert.equal(incidentGlyph('ACCIDENT'), 'car');
  assert.equal(incidentGlyph('road accident'), 'car');
  assert.equal(incidentGlyph('FIRE'), 'flame');
  assert.equal(incidentGlyph('TRAUMA'), 'person');
  assert.equal(incidentGlyph('FALL'), 'person');
  assert.equal(incidentGlyph('MEDICAL'), 'alert');
  assert.equal(incidentGlyph(undefined), 'alert');

  const high = incidentMarkerHtml({incident_type: 'CARDIAC', severity: 'HIGH'});
  assert.match(high, /data-glyph="heart"/);
  assert.doesNotMatch(high, /mk-pulse/);
  assert.doesNotMatch(high, />\s*HIGH\s*</);
  assert.doesNotMatch(high, EMOJI);
  const critical = incidentMarkerHtml({incident_type: 'ACCIDENT', severity: 'CRITICAL'});
  assert.match(critical, /data-glyph="car"/);
  assert.match(critical, /mk-pulse/);
  assert.notEqual(high.match(/--mk-color:([^;"]+)/)[1], critical.match(/--mk-color:([^;"]+)/)[1]);
});

test('hospital pin has a cross glyph and no always-on bed label', () => {
  const html = hospitalMarkerHtml({name: 'City General', available_beds: 2, icu_beds_available: 1});
  assert.match(html, /data-glyph="hospital"/);
  assert.doesNotMatch(html, /BEDS/);
  assert.doesNotMatch(html, EMOJI);
});

test('text from the database is escaped', () => {
  const html = ambulanceMarkerHtml({id: 'x', call_sign: '<img src=x onerror=alert(1)>', status: 'AVAILABLE'}, {now: NOW});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('route badge shows callsign, distance and ETA compactly', () => {
  assert.equal(routeBadgeText('Delta-4', '23.9', 38), 'Delta-4 · 23.9 km · 38 min');
});

test('marker state key changes exactly when the drawn look changes', async () => {
  const {ambulanceMarkerKey, incidentMarkerKey} = await import('../src/map/markers.js');
  const amb = {id: 'A', call_sign: 'Alpha-1', status: 'AVAILABLE', last_ping: '2026-11-06T09:59:30Z', latitude: 12.9};
  const k = ambulanceMarkerKey(amb, {now: NOW});
  assert.equal(ambulanceMarkerKey({...amb, latitude: 13.1}, {now: NOW}), k);
  assert.notEqual(ambulanceMarkerKey({...amb, status: 'EN_ROUTE_TO_SCENE'}, {now: NOW}), k);
  assert.notEqual(ambulanceMarkerKey(amb, {now: NOW + 10 * 60000}), k);
  assert.notEqual(ambulanceMarkerKey({...amb, call_sign: 'Alpha-2'}, {now: NOW}), k);
  const inc = {incident_type: 'CARDIAC', severity: 'HIGH', location_lat: 1};
  assert.equal(incidentMarkerKey({...inc, location_lat: 2}), incidentMarkerKey(inc));
  assert.notEqual(incidentMarkerKey({...inc, severity: 'CRITICAL'}), incidentMarkerKey(inc));
});
