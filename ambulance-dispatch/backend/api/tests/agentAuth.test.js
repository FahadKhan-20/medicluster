const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../server');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

function signAgentToken(secret, payloadOverrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'agent-core',
    kind: 'agent',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payloadOverrides,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

test('Dispatch API agent token authorization', async (t) => {
  const secret = 'test-secret-at-least-32-chars-long-security-key';
  const calls = [];
  const fixture = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/rest/v1/incidents')) return res.end(JSON.stringify([{ id: 'INC-1', status: 'PENDING', location_lat: 12.97, location_lng: 77.59 }]));
    if (req.url.startsWith('/rest/v1/rpc/dispatch_assign')) return res.end(JSON.stringify({ id: 'INC-1', status: 'ASSIGNED' }));
    if (req.url === '/auth/v1/user') {
      if (req.headers.authorization === 'Bearer valid-supabase-token') {
        return res.end(JSON.stringify({ id: 'user-1' }));
      }
      res.statusCode = 401;
      return res.end(JSON.stringify({ message: 'Invalid or expired token' }));
    }
    if (req.url.startsWith('/rest/v1/profiles')) return res.end(JSON.stringify([{ id: 'user-1', role: 'DISPATCHER' }]));
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });

  const fixtureUrl = await listen(fixture);
  const server = http.createServer(createApp({
    url: fixtureUrl,
    key: 'test-key',
    agentJwtSecret: secret,
  }));
  const api = await listen(server);
  t.after(() => Promise.all([new Promise(r => server.close(r)), new Promise(r => fixture.close(r))]));

  const request = async (path, method = 'GET', body, token) => {
    const response = await fetch(api + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  await t.test('valid agent token gains DISPATCHER access to /api/auth/me without calling Supabase user', async () => {
    const token = signAgentToken(secret);
    const beforeCalls = calls.length;
    const res = await request('/api/auth/me', 'GET', undefined, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'DISPATCHER');
    assert.equal(res.body.id, 'agent-core');
    // Supabase /auth/v1/user should NOT be called for agent
    assert.equal(calls.slice(beforeCalls).some(c => c.path === '/auth/v1/user'), false);
  });

  await t.test('valid agent token can read incidents and call assignments', async () => {
    const token = signAgentToken(secret);
    const incRes = await request('/api/incidents', 'GET', undefined, token);
    assert.equal(incRes.status, 200);
    assert.equal(incRes.body[0].id, 'INC-1');

    const assignRes = await request('/api/assignments', 'POST', {
      incidentId: 'INC-1',
      ambulanceId: 'AMB-1',
      hospitalId: 'HOSP-1',
      notes: 'Automated test dispatch',
    }, token);
    assert.equal(assignRes.status, 201);
    assert.equal(assignRes.body.incident_id, 'INC-1');
  });

  await t.test('tampered agent token fails signature and is rejected by upstream auth', async () => {
    const token = signAgentToken(secret);
    const tampered = token.slice(0, -5) + 'xxxxx';
    const res = await request('/api/auth/me', 'GET', undefined, tampered);
    assert.equal(res.status, 401);
  });

  await t.test('expired agent token is rejected', async () => {
    const expired = signAgentToken(secret, { exp: Math.floor(Date.now() / 1000) - 100 });
    const res = await request('/api/auth/me', 'GET', undefined, expired);
    assert.equal(res.status, 401);
  });

  await t.test('token with wrong sub or kind is rejected as agent token', async () => {
    const wrongSub = signAgentToken(secret, { sub: 'attacker' });
    const res1 = await request('/api/auth/me', 'GET', undefined, wrongSub);
    assert.equal(res1.status, 401);

    const wrongKind = signAgentToken(secret, { kind: 'user' });
    const res2 = await request('/api/auth/me', 'GET', undefined, wrongKind);
    assert.equal(res2.status, 401);
  });
});
