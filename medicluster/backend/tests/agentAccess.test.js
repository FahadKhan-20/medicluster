const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { signToken, signAgentToken, requireAuth } = require('../middleware/auth');

const JWT_SECRET = 'agent-access-test-jwt-secret-at-least-32-chars';
const AGENT_SECRET = 'agent-access-test-agent-secret-at-least-32-chars';

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
  const reply = (req, res) => res.json({ ok: true, userId: req.userId });
  app.get('/api/media/models', requireAuth, reply);
  app.post('/api/media/analyze/:id', requireAuth, reply);
  app.post('/api/media/review/:id', requireAuth, reply);
  app.post('/api/alerts/agent', requireAuth, reply);
  app.get('/api/alerts', requireAuth, reply);
  app.get('/api/data/x', requireAuth, reply);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (method, path, token) => fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}` } });
}

test('agent token reaches allowlisted routes', async t => {
  const call = await setup(t);
  const token = signAgentToken();
  for (const [method, path] of [
    ['GET', '/api/media/models'],
    ['POST', '/api/media/analyze/file_1-a'],
    ['POST', '/api/media/review/file_1-a'],
    ['POST', '/api/alerts/agent'],
  ]) {
    const res = await call(method, path, token);
    assert.equal(res.status, 200, `${method} ${path}`);
    assert.equal((await res.json()).userId, 'agent-core');
  }
});

test('agent token is 403 elsewhere', async t => {
  const call = await setup(t);
  const token = signAgentToken();
  for (const path of ['/api/alerts', '/api/data/x']) {
    const res = await call('GET', path, token);
    assert.equal(res.status, 403, path);
    assert.deepEqual(await res.json(), { error: 'Agent access not permitted for this route' });
  }
});

test('agent token signed with JWT_SECRET is rejected', async t => {
  const call = await setup(t);
  const token = jwt.sign({ sub: 'agent-core', kind: 'agent' }, JWT_SECRET);
  assert.equal((await call('GET', '/api/media/models', token)).status, 401);
});

test('missing AGENT_JWT_SECRET disables agent tokens', async t => {
  const call = await setup(t);
  const agent = signAgentToken();
  delete process.env.AGENT_JWT_SECRET;
  assert.equal((await call('GET', '/api/media/models', agent)).status, 401);
  const clinician = signToken({ _id: 'user-1' });
  assert.equal((await call('GET', '/api/media/models', clinician)).status, 200);
});

test('signAgentToken throws when AGENT_JWT_SECRET is shorter than 32 chars', async t => {
  await setup(t);
  process.env.AGENT_JWT_SECRET = 'too-short';
  assert.throws(() => signAgentToken());
});
