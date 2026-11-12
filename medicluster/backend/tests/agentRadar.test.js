const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { signAgentToken, requireAuth } = require('../middleware/auth');

const JWT_SECRET = 'agent-radar-test-jwt-secret-at-least-32-chars';
const AGENT_SECRET = 'agent-radar-test-agent-secret-at-least-32-chars';

async function setup(t) {
  const previous = Object.fromEntries(['JWT_SECRET', 'AGENT_JWT_SECRET', 'ALLOWED_STAFF_EMAILS'].map(k => [k, process.env[k]]));
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_JWT_SECRET = AGENT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const app = express();
  app.use(express.json());
  const reply = (req, res) => res.json({ ok: true, userId: req.userId, agent: req.agent });
  app.post('/api/intelligence/radar/sessions/:id/forecast', requireAuth, reply);
  app.get('/api/intelligence/radar/sessions/:id', requireAuth, reply);
  app.post('/api/intelligence/radar/sessions/:id/step', requireAuth, reply);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (method, path, token, body) =>
    fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

test('agent token reaches radar forecast endpoint in AGENT_ROUTES', async t => {
  const call = await setup(t);
  const token = signAgentToken();
  const sessionId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const res = await call('POST', `/api/intelligence/radar/sessions/${sessionId}/forecast`, token, { steps: 6 });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.userId, 'agent-core');
  assert.equal(json.agent, true);
});

test('agent token is 403 on non-allowlisted radar routes', async t => {
  const call = await setup(t);
  const token = signAgentToken();
  const sessionId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  // GET session details is not in AGENT_ROUTES
  const getRes = await call('GET', `/api/intelligence/radar/sessions/${sessionId}`, token);
  assert.equal(getRes.status, 403);
  assert.deepEqual(await getRes.json(), { error: 'Agent access not permitted for this route' });

  // POST step is not in AGENT_ROUTES
  const stepRes = await call('POST', `/api/intelligence/radar/sessions/${sessionId}/step`, token);
  assert.equal(stepRes.status, 403);
  assert.deepEqual(await stepRes.json(), { error: 'Agent access not permitted for this route' });
});
