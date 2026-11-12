const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signToken, signAgentToken, requireAuth } = require('../middleware/auth');

const body = (overrides = {}) => ({
  patient_id: 'P-1',
  source_id: 'media-1',
  severity: 'HIGH',
  title: 'Possible pneumonia flagged',
  summary: 'Jev recommends clinician review.',
  jev_probabilities: { action: { suggest: 0.93, ignore: 0.07 } },
  audit_id: 'audit-1',
  ...overrides,
});

async function setup(t) {
  await createTestDatabase(t);
  const previous = Object.fromEntries(['JWT_SECRET', 'AGENT_JWT_SECRET', 'ALLOWED_STAFF_EMAILS', 'ALLOWED_EMAIL_DOMAINS'].map(k => [k, process.env[k]]));
  process.env.JWT_SECRET = 'agent-alerts-test-jwt-secret-at-least-32-chars';
  process.env.AGENT_JWT_SECRET = 'agent-alerts-test-agent-secret-at-least-32-chars';
  delete process.env.ALLOWED_STAFF_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', requireAuth, require('../routes/alertRoutes'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, payload) => {
    const res = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, agent: signAgentToken(), clinician: signToken('clinician-1') };
}

test('agent creates alert', async t => {
  const { call, agent } = await setup(t);
  const res = await call('POST', '/api/alerts/agent', agent, body());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body._id);
  for (const k of ['patient_id', 'source_id', 'severity', 'title', 'summary', 'audit_id']) assert.equal(res.body[k], body()[k], k);
  assert.deepEqual(res.body.jev_probabilities, body().jev_probabilities);
});

test('duplicate source_id+audit_id returns existing', async t => {
  const { call, agent } = await setup(t);
  const AgentAlert = require('../models/AgentAlert');
  const first = await call('POST', '/api/alerts/agent', agent, body());
  const second = await call('POST', '/api/alerts/agent', agent, body({ title: 'Different title' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body._id, first.body._id);
  assert.equal(await AgentAlert.countDocuments({}), 1);
});

test('validation', async t => {
  const { call, agent } = await setup(t);
  const { patient_id, ...missing } = body();
  const cases = {
    'missing patient_id': missing,
    'severity LOW': body({ severity: 'LOW' }),
    'title over 200 chars': body({ title: 'x'.repeat(201) }),
    'jev_probabilities over 4000 chars': body({ jev_probabilities: { action: { blob: 'y'.repeat(4000) } } }),
  };
  for (const [name, payload] of Object.entries(cases)) {
    const res = await call('POST', '/api/alerts/agent', agent, payload);
    assert.equal(res.status, 400, name);
  }
});

test('clinician token cannot POST /agent', async t => {
  const { call, clinician } = await setup(t);
  const res = await call('POST', '/api/alerts/agent', clinician, body());
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Agent sign-in required' });
});

test('GET merges agent alerts', async t => {
  const { call, agent, clinician } = await setup(t);
  const created = await call('POST', '/api/alerts/agent', agent, body());
  const res = await call('GET', '/api/alerts', clinician);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const item = res.body.find(a => a.source === 'agent');
  assert.ok(item);
  assert.equal(item.id, `agent:${created.body._id}`);
  assert.equal(item.severity, 'HIGH');
  assert.equal(item.patientId, 'P-1');
  assert.equal(item.title, 'Possible pneumonia flagged');
  assert.equal(item.body, 'Jev recommends clinician review.');
  assert.deepEqual(item.facts, [['Decided by', 'Jev'], ['Confidence', '93%']]);
  assert.equal(item.link, '/patient/P-1');
  assert.equal(item.read, false);
  const times = res.body.map(a => new Date(a.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});
