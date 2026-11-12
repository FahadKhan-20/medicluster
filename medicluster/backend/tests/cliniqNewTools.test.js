const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { createTools } = require('../services/cliniqTools');
const { createAgent } = require('../services/cliniqAgent');
const { createRouter } = require('../routes/cliniqRoutes');
const { signPatientToken, signToken } = require('../middleware/auth');
const Emergency = require('../models/PatientEmergency');

const patientSession = { kind: 'patient', patientId: 'P_CHATOOLS_1' };
const clinicianSession = { kind: 'clinician', userId: 'staff_1', role: 'doctor' };
const adminSession = { kind: 'clinician', userId: 'admin_1', role: 'admin' };
const dispatcherSession = { kind: 'clinician', userId: 'disp_1', role: 'dispatcher' };

test('role scoping for all new chattools tools', async () => {
  const tools = createTools({
    request: async () => ({}),
    dispatchFetch: async () => ({})
  });

  // Patient cannot call clinician tools
  const clinicianOnlyTools = [
    'active_incidents',
    'incident_status',
    'list_alerts',
    'acknowledge_alert',
    'ecg_records',
    'interpret_ecg',
    'sepsis_risk',
    'start_code_blue',
    'imaging_findings_summary',
    'agent_status',
    'agent_recent_decisions',
    'explain_agent_decision',
    'agent_stop',
    'agent_start',
    'dispatch_ambulance'
  ];

  for (const tool of clinicianOnlyTools) {
    await assert.rejects(
      tools.execute(patientSession, tool, { patientId: 'P_CHATOOLS_1', alertId: 'a1', recordId: 'e1', incidentId: 'i1', ambulanceId: 'u1', auditId: 'aud1' }, {}),
      e => e.status === 403,
      `Expected patient to be rejected from ${tool}`
    );
  }

  // Clinician cannot call patient-only tools
  await assert.rejects(
    tools.execute(clinicianSession, 'my_emergency_status', {}, {}),
    e => e.status === 403,
    'Expected clinician to be rejected from my_emergency_status'
  );

  // Non-admin clinician cannot call agent control tools
  const adminOnlyTools = [
    'agent_status',
    'agent_recent_decisions',
    'explain_agent_decision',
    'agent_stop',
    'agent_start'
  ];

  for (const tool of adminOnlyTools) {
    await assert.rejects(
      tools.execute(clinicianSession, tool, { auditId: 'aud1' }, { approved: true }),
      e => e.status === 403,
      `Expected non-admin clinician to be rejected from ${tool}`
    );
  }

  // Non-dispatcher cannot call dispatch_ambulance
  await assert.rejects(
    tools.execute(clinicianSession, 'dispatch_ambulance', { incidentId: 'i1', ambulanceId: 'u1' }, { approved: true }),
    e => e.status === 403,
    'Expected non-dispatcher to be rejected from dispatch_ambulance'
  );

  // Admin clinician has agent tools in catalog and can execute them
  const adminTools = tools.catalog(adminSession).map(t => t.function.name);
  for (const tool of adminOnlyTools) {
    assert.ok(adminTools.includes(tool), `Admin catalog must include ${tool}`);
  }
  assert.ok(adminTools.includes('dispatch_ambulance'), 'Admin catalog must include dispatch_ambulance');

  // Dispatcher clinician has dispatch_ambulance in catalog
  const dispTools = tools.catalog(dispatcherSession).map(t => t.function.name);
  assert.ok(dispTools.includes('dispatch_ambulance'), 'Dispatcher catalog must include dispatch_ambulance');
});

test('action tools require explicit confirmation (cannot auto-execute without context.approved)', async () => {
  const tools = createTools({
    request: async () => ({}),
    dispatchFetch: async () => ({})
  });

  const actionCases = [
    { session: clinicianSession, tool: 'acknowledge_alert', args: { alertId: 'alt-1' } },
    { session: clinicianSession, tool: 'start_code_blue', args: { patientId: 'P001' } },
    { session: adminSession, tool: 'agent_stop', args: { reason: 'Test' } },
    { session: adminSession, tool: 'agent_start', args: {} },
    { session: dispatcherSession, tool: 'dispatch_ambulance', args: { incidentId: 'i1', ambulanceId: 'u1' } }
  ];

  for (const { session, tool, args } of actionCases) {
    await assert.rejects(
      tools.execute(session, tool, args, { approved: false }),
      e => e.status === 409,
      `Action ${tool} must require approval`
    );
  }
});

test('agent proposes actions and requires confirmation without auto-executing', async () => {
  const tools = createTools({
    request: async () => ({}),
    dispatchFetch: async () => ({})
  });

  let proposal = null;
  const agent = createAgent({
    tools,
    propose: async (session, name, args) => {
      proposal = { name, args };
      return { id: 'act-123', tool: name, arguments: args };
    },
    complete: async () => ({
      message: {
        tool_calls: [{
          id: 'call-codeblue',
          type: 'function',
          function: { name: 'start_code_blue', arguments: JSON.stringify({ patientId: 'P001' }) }
        }]
      }
    })
  });

  const res = await agent.chat(clinicianSession, { question: 'Start code blue for P001' }, { requestId: 'req-cb-1' });
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].id, 'act-123');
  assert.ok(res.reply.includes('Review the proposed action'));
  assert.equal(proposal.name, 'start_code_blue');
});

test('emergency status privacy: patient sees only own emergency, and closed incidents omit crew GPS', async t => {
  await createTestDatabase(t);

  const ownEmergency = await Emergency.create({
    patientId: patientSession.patientId,
    location: { latitude: 12.9, longitude: 77.6, address: 'Home' },
    status: 'CLOSED',
    incidentId: 'INC-OWN-1'
  });

  const otherEmergency = await Emergency.create({
    patientId: 'P_OTHER_999',
    location: { latitude: 13.0, longitude: 77.7, address: 'Other' },
    status: 'ASSIGNED',
    incidentId: 'INC-OTHER-1'
  });

  const tools = createTools({
    request: async () => ({}),
    cadTrack: async (row) => ({
      id: row.incidentId,
      status: 'CLOSED',
      ambulance: null
    })
  });

  const status = await tools.execute(patientSession, 'my_emergency_status', {}, {});
  assert.equal(status.active, false);
  // Crew GPS must not be leaked after closed
  assert.equal(status.crew, undefined);

  // Other patient's emergency is not returned to this patient
  const emergencies = await Emergency.find({ patientId: patientSession.patientId }).lean();
  assert.ok(emergencies.every(e => e.patientId === patientSession.patientId));
  assert.ok(!emergencies.some(e => e._id.toString() === otherEmergency._id.toString()));
});

test('dispatch upstream down returns 503 friendly error message', async () => {
  const tools = createTools({
    request: async () => ({}),
    dispatchFetch: async () => {
      const err = new Error('ECONNREFUSED');
      err.status = 503;
      throw err;
    }
  });

  await assert.rejects(
    tools.execute(clinicianSession, 'nearby_ambulances', { lat: 12.9, lng: 77.6 }, {}),
    e => e.status === 503 && e.message === 'Dispatch service unavailable'
  );

  await assert.rejects(
    tools.execute(clinicianSession, 'active_incidents', {}, {}),
    e => e.status === 503 && e.message === 'Dispatch service unavailable'
  );

  await assert.rejects(
    tools.execute(clinicianSession, 'incident_status', { incidentId: 'i-1' }, {}),
    e => e.status === 503 && e.message === 'Dispatch service unavailable'
  );

  await assert.rejects(
    tools.execute(dispatcherSession, 'dispatch_ambulance', { incidentId: 'i-1', ambulanceId: 'u-1' }, { approved: true }),
    e => e.status === 503 && e.message === 'Dispatch service unavailable'
  );
});

test('explain_agent_decision formats plain summary with event, probabilities, verdict, tools, outcome', async () => {
  const mockDecision = {
    event: { type: 'vitals_deterioration', patientId: 'P001' },
    gateVerdict: 'APPROVED',
    decision: { probabilities: { deterioration: 0.88, stable: 0.12 } },
    toolCalls: [{ tool: 'list_alerts' }, { tool: 'create_alert' }],
    outcome: 'ALERT_DISPATCHED'
  };

  const tools = createTools({
    request: async (path) => {
      if (path === '/api/agent/audit/audit-42') return mockDecision;
      return {};
    }
  });

  const res = await tools.execute(adminSession, 'explain_agent_decision', { auditId: 'audit-42' }, {});
  assert.equal(res.auditId, 'audit-42');
  assert.equal(res.eventType, 'vitals_deterioration');
  assert.equal(res.gateVerdict, 'APPROVED');
  assert.equal(res.outcome, 'ALERT_DISPATCHED');
  assert.deepEqual(res.jevProbabilities, { deterioration: 0.88, stable: 0.12 });
  assert.ok(res.plainSummary.includes('Event: vitals_deterioration'));
  assert.ok(res.plainSummary.includes('Gate Verdict: APPROVED'));
  assert.ok(res.plainSummary.includes('list_alerts, create_alert'));
  assert.ok(res.plainSummary.includes('Outcome: ALERT_DISPATCHED'));
});

test('emit per-step tool events from cliniqAgent and SSE stream on POST /api/cliniq/chat?stream=1', async t => {
  await createTestDatabase(t);

  const prevJwt = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'cliniq-sse-test-secret-at-least-32-chars';
  t.after(() => {
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
  });

  const steps = [];
  const tools = createTools({
    request: async (path) => {
      if (path.includes('/api/alerts')) return [{ id: 'alt-1', title: 'High HR', severity: 'critical' }];
      return {};
    }
  });

  let round = 0;
  const mockComplete = async () => {
    if (round++ === 0) {
      return {
        message: {
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'list_alerts', arguments: JSON.stringify({ filter: 'unread' }) }
          }]
        },
        model: 'test-model'
      };
    }
    return {
      message: { content: 'Found 1 critical alert.' },
      model: 'test-model'
    };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/cliniq', createRouter({
    request: async (path) => {
      if (path.includes('/api/alerts')) return [{ id: 'alt-1', title: 'High HR', severity: 'critical' }];
      return {};
    },
    complete: mockComplete
  }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const origin = `http://127.0.0.1:${server.address().port}/api/cliniq`;
  const token = signToken({ id: 'staff-1', role: 'doctor' });

  // Test 1: Non-stream POST /api/cliniq/chat returns standard JSON response
  const nonStreamRes = await fetch(`${origin}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      question: 'Check alerts',
      requestId: 'req-non-stream-1',
      history: []
    })
  });

  assert.equal(nonStreamRes.status, 200);
  assert.ok(nonStreamRes.headers.get('content-type')?.includes('application/json'));
  const nonStreamData = await nonStreamRes.json();
  assert.equal(nonStreamData.reply, 'Found 1 critical alert.');
  assert.equal(nonStreamData.role, 'clinician');
  assert.ok(Array.isArray(nonStreamData.results));

  // Test 2: SSE Stream on POST /api/cliniq/chat?stream=1
  round = 0; // reset model mock
  const streamRes = await fetch(`${origin}/chat?stream=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      question: 'Check alerts',
      requestId: 'req-stream-1',
      history: []
    })
  });

  assert.equal(streamRes.status, 200);
  assert.ok(streamRes.headers.get('content-type')?.includes('text/event-stream'));

  const rawText = await streamRes.text();
  assert.ok(rawText.includes('event: tool_start'));
  assert.ok(rawText.includes('event: tool_end'));
  assert.ok(rawText.includes('event: done'));
  assert.ok(rawText.includes('"name":"list_alerts"'));
  assert.ok(rawText.includes('filter: unread'));
  assert.ok(rawText.includes('"reply":"Found 1 critical alert."'));
});
