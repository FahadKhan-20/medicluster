import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionTrace } from '../src/chat/stepTimelineState.js';
import { identifyResultCard } from '../src/chat/chatCardSelection.js';

test('buildExecutionTrace creates sequential trace: Understanding -> Tool Calls -> Results -> Done', () => {
  const agentData = {
    provider: 'cliniq',
    model: 'medicluster-v1',
    results: [
      {
        tool: 'nearby_ambulances',
        data: {
          ambulances: [
            { ambulance_id: 'A1', callsign: 'Medic 1', status: 'AVAILABLE' },
            { ambulance_id: 'A2', callsign: 'Rescue 2', status: 'AVAILABLE' },
          ],
        },
      },
    ],
    actions: [],
  };

  const trace = buildExecutionTrace(agentData);
  assert.equal(trace.length, 3);
  assert.equal(trace[0].label, 'Understanding request');
  assert.equal(trace[0].status, 'completed');
  assert.match(trace[0].detail, /medicluster-v1/);

  assert.equal(trace[1].label, 'Calling tool nearby_ambulances');
  assert.equal(trace[1].status, 'completed');
  assert.match(trace[1].detail, /2 ambulance units located/);

  assert.equal(trace[2].label, 'Done');
  assert.equal(trace[2].status, 'completed');
});

test('buildExecutionTrace handles multi-step request with action confirmation', () => {
  const agentData = {
    provider: 'cliniq',
    model: 'medicluster-v1',
    results: [
      {
        tool: 'critical_alerts',
        data: {
          alerts: [{ id: 'ALT-1', severity: 'CRITICAL', title: 'Sepsis Indicator' }],
        },
      },
      {
        tool: 'analyze_image',
        data: {
          findings: 'Right lower lobe infiltrate',
        },
      },
    ],
    actions: [
      {
        id: 'action-1',
        tool: 'acknowledge_alert',
        arguments: { alertId: 'ALT-1' },
      },
    ],
  };

  const trace = buildExecutionTrace(agentData);
  assert.equal(trace.length, 5);
  assert.equal(trace[0].label, 'Understanding request');
  assert.equal(trace[1].label, 'Calling tool critical_alerts');
  assert.match(trace[1].detail, /Alert status retrieved/);
  assert.equal(trace[2].label, 'Calling tool analyze_image');
  assert.match(trace[2].detail, /Neural imaging findings extracted/);
  assert.equal(trace[3].label, 'Needs your confirmation');
  assert.equal(trace[3].status, 'pending');
  assert.equal(trace[4].label, 'Done');
  assert.equal(trace[4].status, 'pending');
});

test('buildExecutionTrace handles tool error safely', () => {
  const agentData = {
    results: [
      {
        tool: 'fetch_vitals',
        error: 'Sensor offline',
      },
    ],
  };

  const trace = buildExecutionTrace(agentData);
  assert.equal(trace[1].label, 'Calling tool fetch_vitals');
  assert.equal(trace[1].status, 'error');
  assert.match(trace[1].detail, /Sensor offline/);
});

test('identifyResultCard identifies explain_agent_decision and agent_recent_decisions', () => {
  assert.equal(
    identifyResultCard({ tool: 'explain_agent_decision', data: { decision: { action: 'Dispatch' } } }),
    'agent_decision'
  );
  assert.equal(
    identifyResultCard({ tool: 'agent_recent_decisions', data: { audit: { id: 'AUD-1' } } }),
    'agent_decision'
  );
});
