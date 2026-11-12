import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardColumns, readPanels, savePanels, RAIL_WIDTH} from '../src/services/dashboardLayout.js';

const memory = (init = {}) => { const m = new Map(Object.entries(init)); return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v))}; };

test('open sides keep their width, closed sides shrink to the rail, map takes the rest', () => {
  assert.equal(RAIL_WIDTH, 44);
  assert.deepEqual(dashboardColumns({left: true, right: true}), {lg: '300px minmax(0,1fr) 310px', xl: '330px minmax(0,1fr) 330px'});
  assert.deepEqual(dashboardColumns({left: false, right: true}), {lg: '44px minmax(0,1fr) 310px', xl: '44px minmax(0,1fr) 330px'});
  assert.deepEqual(dashboardColumns({left: false, right: false}), {lg: '44px minmax(0,1fr) 44px', xl: '44px minmax(0,1fr) 44px'});
});

test('panel state survives a reload and bad saved data falls back to both open', () => {
  const store = memory();
  assert.deepEqual(readPanels(store), {left: true, right: true});
  savePanels(store, {left: false, right: true});
  assert.deepEqual(readPanels(store), {left: false, right: true});
  assert.deepEqual(readPanels(memory({'dispatch.panels': '{broken'})), {left: true, right: true});
  assert.deepEqual(readPanels(memory({'dispatch.panels': '{"left":"no"}'})), {left: true, right: true});
  assert.deepEqual(readPanels(null), {left: true, right: true});
  assert.doesNotThrow(() => savePanels({setItem() { throw new Error('quota'); }}, {left: true, right: true}));
});
