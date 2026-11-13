import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyResultCard } from '../src/chat/chatCardSelection.js';
import {
  getActionDescription,
  computeNextActionState,
} from '../src/chat/actionConfirmState.js';

test('identifyResultCard identifies ambulance list by tool name and result shape', () => {
  // By tool name
  assert.equal(identifyResultCard({ tool: 'nearby_ambulances', data: { ambulances: [] } }), 'ambulance_list');
  assert.equal(identifyResultCard({ tool: 'find_ambulances', data: { list: [] } }), 'ambulance_list');
  assert.equal(identifyResultCard({ tool: 'ambulances', data: [] }), 'ambulance_list');

  // By data shape
  assert.equal(
    identifyResultCard({
      tool: 'custom_query',
      data: { ambulances: [{ callsign: 'MED-1', status: 'AVAILABLE' }] },
    }),
    'ambulance_list'
  );
  assert.equal(
    identifyResultCard({
      tool: 'query',
      data: [{ ambulance_id: 'AMB-101', latitude: 37.77, longitude: -122.41 }],
    }),
    'ambulance_list'
  );
});

test('identifyResultCard identifies emergency tracking by tool name and result shape', () => {
  assert.equal(identifyResultCard({ tool: 'send_sos', data: { status: 'DISPATCHED' } }), 'emergency_tracking');
  assert.equal(identifyResultCard({ tool: 'track_emergency', data: { id: 'sos-1' } }), 'emergency_tracking');
  assert.equal(
    identifyResultCard({
      tool: 'status',
      data: { incidentId: 'INC-99', stage: 'EN_ROUTE' },
    }),
    'emergency_tracking'
  );
  assert.equal(
    identifyResultCard({
      tool: 'patient_status',
      data: { emergency: { status: 'ON_SCENE' } },
    }),
    'emergency_tracking'
  );
});

test('identifyResultCard identifies alerts by tool name and result shape', () => {
  assert.equal(identifyResultCard({ tool: 'critical_alerts', data: { alerts: [] } }), 'alert');
  assert.equal(identifyResultCard({ tool: 'alerts', data: [] }), 'alert');
  assert.equal(
    identifyResultCard({
      tool: 'check',
      data: { alerts: [{ severity: 'CRITICAL', title: 'Severe Hypoxia' }] },
    }),
    'alert'
  );
  assert.equal(
    identifyResultCard({
      tool: 'check',
      data: { severity: 'HIGH', title: 'Tachycardia alert' },
    }),
    'alert'
  );
});

test('identifyResultCard identifies imaging findings by tool name and result shape', () => {
  assert.equal(identifyResultCard({ tool: 'analyze_image', data: { findings: 'Clear lung fields' } }), 'imaging_finding');
  assert.equal(identifyResultCard({ tool: 'imaging_summary', data: { model: 'DenseNet121' } }), 'imaging_finding');
  assert.equal(
    identifyResultCard({
      tool: 'chest_xray',
      data: { heatmapUrl: 'blob:http://localhost/heatmap.png', confidence: 0.94 },
    }),
    'imaging_finding'
  );
  assert.equal(
    identifyResultCard({
      tool: 'inspect',
      data: { fileId: 'img-101', findings: 'No consolidation' },
    }),
    'imaging_finding'
  );
});

test('identifyResultCard identifies Code Blue drills and suggestions', () => {
  assert.equal(identifyResultCard({ tool: 'codeblue_start', data: { status: 'ACTIVE' } }), 'codeblue');
  assert.equal(identifyResultCard({ tool: 'codeblue_suggest', data: { action: 'Defibrillate 200J' } }), 'codeblue');
  assert.equal(
    identifyResultCard({
      tool: 'resuscitation',
      data: { card: { action: 'Administer Epinephrine 1mg', supporting_agents: ['Dr. Rao'] } },
    }),
    'codeblue'
  );
});

test('identifyResultCard identifies physiological risk (ECG & sepsis)', () => {
  assert.equal(identifyResultCard({ tool: 'ecg_analyze', data: { st_elevation: true } }), 'risk');
  assert.equal(identifyResultCard({ tool: 'sepsis_score', data: { risk: 0.88, band: 'HIGH' } }), 'risk');
  assert.equal(
    identifyResultCard({
      tool: 'vitals',
      data: { sepsis: { risk: 0.75, top_factors: ['WBC > 12000'] } },
    }),
    'risk'
  );
  assert.equal(
    identifyResultCard({
      tool: 'calc',
      data: { heart_rate: 135, systolic_bp: 82, temperature: 38.9 },
    }),
    'risk'
  );
});

test('identifyResultCard identifies agent decision audits with replay capabilities', () => {
  assert.equal(identifyResultCard({ tool: 'agent_decision', data: { decision: { action: 'Dispatch' } } }), 'agent_decision');
  assert.equal(identifyResultCard({ tool: 'agent_audits', data: { audit: {} } }), 'agent_decision');
  assert.equal(
    identifyResultCard({
      tool: 'query',
      data: { decision: { action: 'Escalate to attending', outcome: 'executed', confidence: 0.96 } },
    }),
    'agent_decision'
  );
});

test('identifyResultCard falls back to generic for undefined or pending data', () => {
  assert.equal(identifyResultCard(null), 'generic');
  assert.equal(identifyResultCard({}), 'generic');
  assert.equal(identifyResultCard({ tool: 'unknown', data: { pending: true } }), 'generic');
  assert.equal(identifyResultCard({ tool: 'generic_tool', data: { note: 'test' } }), 'generic');
});

test('getActionDescription generates human-readable descriptions of proposed actions', () => {
  const sosDesc = getActionDescription({
    tool: 'send_sos',
    location: { latitude: 37.7749, longitude: -122.4194 },
  });
  assert.match(sosDesc, /Dispatch an emergency SOS response unit/);
  assert.match(sosDesc, /37\.7749/);

  const reminderDesc = getActionDescription({
    tool: 'create_reminder',
    arguments: { medicationName: 'Metformin', dosage: '500mg', times: ['08:00', '20:00'] },
  });
  assert.match(reminderDesc, /Metformin/);
  assert.match(reminderDesc, /500mg/);

  const ackDesc = getActionDescription({
    tool: 'acknowledge_alert',
    arguments: { alertId: 'ALT-404' },
  });
  assert.match(ackDesc, /Mark alert ALT-404 as clinician-reviewed/);
});

test('computeNextActionState enforces safety invariant: NEVER auto-confirms', () => {
  // Pending remains pending if no decision is made
  assert.equal(computeNextActionState('pending', null, null), 'pending');
  assert.equal(computeNextActionState('pending', undefined, null), 'pending');

  // Explicit user approval transitions to succeeded
  assert.equal(computeNextActionState('pending', 'approve', { result: { success: true } }), 'succeeded');

  // Explicit cancellation transitions to cancelled
  assert.equal(computeNextActionState('pending', 'cancel', null), 'cancelled');

  // Backend reporting cancelled transitions to cancelled
  assert.equal(computeNextActionState('pending', 'approve', { result: { cancelled: true } }), 'cancelled');

  // Once completed or cancelled, state does not mutate
  assert.equal(computeNextActionState('succeeded', 'cancel', null), 'succeeded');
  assert.equal(computeNextActionState('cancelled', 'approve', null), 'cancelled');
});
