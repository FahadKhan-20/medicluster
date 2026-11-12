const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { signToken, signAgentToken, requireAuth } = require('../middleware/auth');

const JWT_SECRET = 'sepsis-score-test-jwt-secret-at-least-32-chars';
const AGENT_SECRET = 'sepsis-score-test-agent-secret-at-least-32-chars';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('POST /api/ml/sepsis/score proxies to ml-engine and enforces agent auth', async t => {
  const prevEnv = { ...process.env };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_JWT_SECRET = AGENT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Mock ML Engine provider
  const mlEngine = express();
  mlEngine.use(express.json());
  let receivedBody = null;
  mlEngine.post('/sepsis/score', (req, res) => {
    receivedBody = req.body;
    if (!req.body.hours || req.body.hours.length === 0) {
      return res.status(400).json({ error: "'hours' must be non-empty" });
    }
    if (req.body._simulate_503) {
      return res.status(503).json({ error: "Sepsis model unavailable" });
    }
    return res.json({
      risk: 0.85,
      band: "high",
      top_factors: ["Severe tachycardia (HR 120 bpm)", "Hypotension (MAP 62 mmHg)"],
      model: "sepsis2019-hgb-v1",
    });
  });

  const mlOrigin = await listen(t, mlEngine);
  process.env.ML_ENGINE_URL = mlOrigin;

  // Backend App with mlRoutes mounted at /api/ml under requireAuth
  const app = express();
  app.use(express.json());
  app.use('/api/ml', requireAuth, require('../routes/mlRoutes'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const backendOrigin = await listen(t, app);

  // 1. Unauthenticated request -> 401
  const unauth = await fetch(`${backendOrigin}/api/ml/sepsis/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hours: [{ HR: 80 }] }),
  });
  assert.equal(unauth.status, 401);

  // 2. Clinician token -> 200
  const clinicianToken = signToken({ _id: 'clinician_1' });
  const samplePayload = {
    hours: [
      { HR: 110, O2Sat: 92, Temp: 38.5, SBP: 90, MAP: 62, DBP: 50, Resp: 24, Age: 65 },
    ],
  };
  const clinRes = await fetch(`${backendOrigin}/api/ml/sepsis/score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clinicianToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(samplePayload),
  });
  assert.equal(clinRes.status, 200);
  const clinData = await clinRes.json();
  assert.equal(clinData.risk, 0.85);
  assert.equal(clinData.band, 'high');
  assert.equal(clinData.model, 'sepsis2019-hgb-v1');
  assert.deepEqual(receivedBody, samplePayload);

  // 3. Agent token -> allowlisted, returns 200
  const agentToken = signAgentToken();
  const agentRes = await fetch(`${backendOrigin}/api/ml/sepsis/score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(samplePayload),
  });
  assert.equal(agentRes.status, 200);
  const agentData = await agentRes.json();
  assert.equal(agentData.risk, 0.85);
  assert.equal(agentData.band, 'high');

  // 4. Downstream 503 propagated correctly
  const missingModelRes = await fetch(`${backendOrigin}/api/ml/sepsis/score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hours: [{ HR: 80 }], _simulate_503: true }),
  });
  assert.equal(missingModelRes.status, 503);
  assert.deepEqual(await missingModelRes.json(), { error: "Sepsis model unavailable" });

  // 5. Downstream 400 validation error propagated correctly
  const badReqRes = await fetch(`${backendOrigin}/api/ml/sepsis/score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hours: [] }),
  });
  assert.equal(badReqRes.status, 400);
});

test('GET /api/ml/readings/:patientId is allowlisted for agent tokens', async t => {
  const prevEnv = { ...process.env };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_JWT_SECRET = AGENT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/ml', requireAuth, require('../routes/mlRoutes'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const backendOrigin = await listen(t, app);
  const agentToken = signAgentToken();

  // Route matches AGENT_ROUTES allowlist (even if database returns empty or error in mock)
  const res = await fetch(`${backendOrigin}/api/ml/readings/p_test_123`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${agentToken}`,
    },
  });

  // Verify status is not 401 or 403 (access granted)
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});
