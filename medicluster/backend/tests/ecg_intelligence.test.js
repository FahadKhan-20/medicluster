const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('POST /api/intelligence/ecg/analyze proxies to intelligence engine with auth and headers', async t => {
  const before = { ...process.env };
  process.env.JWT_SECRET = 'gateway-test-only-secret-longer-than-32-characters';
  process.env.AGENT_JWT_SECRET = 'gateway-agent-test-secret-longer-than-32-characters';
  process.env.INTELLIGENCE_TOKEN = 'internal-test-secret';

  t.after(() => {
    for (const key of ['JWT_SECRET', 'AGENT_JWT_SECRET', 'INTELLIGENCE_TOKEN', 'INTELLIGENCE_URL']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });

  const seen = [];
  const mockEngine = express();
  mockEngine.use(express.json({ limit: '10mb' }));
  mockEngine.post('/ecg/analyze', (req, res) => {
    seen.push({
      path: req.url,
      actor: req.get('X-Actor-Id'),
      key: req.get('X-Intelligence-Key'),
      body: req.body,
    });
    res.json({
      probabilities: { NORM: 0.85, MI: 0.05, STTC: 0.04, CD: 0.03, HYP: 0.03 },
      top: 'NORM',
      model: 'ecg-ptbxl-v1',
    });
  });

  process.env.INTELLIGENCE_URL = await listen(t, mockEngine);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/intelligence', require('../routes/intelligenceRoutes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const origin = await listen(t, app);
  const { signToken, signPatientToken, signAgentToken } = require('../middleware/auth');

  const dummySignal = Array.from({ length: 12 }, () => Array.from({ length: 1000 }, () => 0.1));

  // 1. Unauthenticated request -> 401
  const unauth = await fetch(`${origin}/api/intelligence/ecg/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal: dummySignal }),
  });
  assert.equal(unauth.status, 401);

  // 2. Patient token -> 403 (clinician/agent only)
  const patientRes = await fetch(`${origin}/api/intelligence/ecg/analyze`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signPatientToken('patient-123')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signal: dummySignal }),
  });
  assert.equal(patientRes.status, 403);

  // 3. Clinician token -> 200 and upstream receives correct actor
  const clinicianRes = await fetch(`${origin}/api/intelligence/ecg/analyze`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signToken({ _id: 'clinician_42' })}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signal: dummySignal }),
  });
  assert.equal(clinicianRes.status, 200);
  assert.equal(clinicianRes.headers.get('cache-control'), 'no-store');
  const clinicianData = await clinicianRes.json();
  assert.equal(clinicianData.model, 'ecg-ptbxl-v1');
  assert.equal(clinicianData.top, 'NORM');
  assert.equal(seen[0].actor, 'clinician_42');
  assert.equal(seen[0].key, 'internal-test-secret');
  assert.equal(seen[0].body.signal.length, 12);

  // 4. Agent token (AGENT_ROUTES allowlist) -> 200
  const agentToken = signAgentToken();
  const agentRes = await fetch(`${origin}/api/intelligence/ecg/analyze`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signal: dummySignal, lead_order: ['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'] }),
  });
  assert.equal(agentRes.status, 200);
  assert.equal(seen[1].actor, 'agent-core');
  assert.equal(seen[1].key, 'internal-test-secret');
  assert.equal(seen[1].body.lead_order.length, 12);

  // 5. Worker unavailable -> 503
  process.env.INTELLIGENCE_URL = 'http://127.0.0.1:59999';
  const downRes = await fetch(`${origin}/api/intelligence/ecg/analyze`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signal: dummySignal }),
  });
  assert.equal(downRes.status, 503);
});
