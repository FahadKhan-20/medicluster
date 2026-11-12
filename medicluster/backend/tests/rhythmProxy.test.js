const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { signToken, signAgentToken } = require('../middleware/auth');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('POST /api/intelligence/rhythm/classify proxies to intelligence worker with agent and clinician tokens', async t => {
  const before = { ...process.env };
  process.env.JWT_SECRET = 'rhythm-proxy-test-secret-longer-than-32-characters';
  process.env.AGENT_JWT_SECRET = 'rhythm-proxy-test-agent-secret-longer-than-32';
  process.env.INTELLIGENCE_TOKEN = 'internal-intel-token-secret';
  delete process.env.ALLOWED_STAFF_EMAILS;

  t.after(() => {
    for (const key of ['JWT_SECRET', 'AGENT_JWT_SECRET', 'INTELLIGENCE_TOKEN', 'INTELLIGENCE_URL', 'ALLOWED_STAFF_EMAILS']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });

  const seen = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/rhythm/classify', (req, res) => {
    seen.push({
      path: req.url,
      actor: req.get('X-Actor-Id'),
      key: req.get('X-Intelligence-Key'),
      body: req.body
    });
    res.json({
      probabilities: { VF: 0.85, VT: 0.1, ASYSTOLE: 0.03, ORGANIZED: 0.02 },
      top: 'VF',
      model: 'arrest-rhythm-v1'
    });
  });

  process.env.INTELLIGENCE_URL = await listen(t, upstream);

  const app = express();
  app.use(express.json());
  app.use('/api/intelligence', require('../routes/intelligenceRoutes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const origin = await listen(t, app);

  // 1. Unauthenticated request -> 401
  const unauth = await fetch(`${origin}/api/intelligence/rhythm/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead: [0.1, 0.2], fs: 250 })
  });
  assert.equal(unauth.status, 401);

  // 2. Agent token -> 200, proxied to upstream with agent-core actor
  const agentToken = signAgentToken();
  const agentRes = await fetch(`${origin}/api/intelligence/rhythm/classify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ lead: [0.1, 0.2, 0.3], fs: 250 })
  });
  assert.equal(agentRes.status, 200);
  const agentData = await agentRes.json();
  assert.equal(agentData.top, 'VF');
  assert.equal(agentData.model, 'arrest-rhythm-v1');
  assert.equal(seen[0].actor, 'agent-core');
  assert.equal(seen[0].key, 'internal-intel-token-secret');
  assert.deepEqual(seen[0].body, { lead: [0.1, 0.2, 0.3], fs: 250 });

  // 3. Clinician token -> 200, proxied with clinician userId
  const clinicianToken = signToken({ _id: 'clinician-dr-smith' });
  const docRes = await fetch(`${origin}/api/intelligence/rhythm/classify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clinicianToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ lead: [0.5, -0.5], fs: 250 })
  });
  assert.equal(docRes.status, 200);
  assert.equal(seen[1].actor, 'clinician-dr-smith');
});
