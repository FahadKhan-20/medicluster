const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../server');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

function signAgentToken(secret, payloadOverrides = {}, omitExp = false) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const basePayload = {
    sub: 'agent-core',
    kind: 'agent',
    ...(omitExp ? {} : { exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...payloadOverrides,
  };
  const payload = Buffer.from(JSON.stringify(basePayload)).toString('base64url');
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
    if (req.url.startsWith('/rest/v1/ambulances')) return res.end(JSON.stringify([{ id: 'AMB-1', status: 'AVAILABLE', latitude: 12.97, longitude: 77.59 }]));
    if (req.url.startsWith('/rest/v1/hospitals')) return res.end(JSON.stringify([{ id: 'HOSP-1', name: 'General', available_beds: 5, latitude: 12.97, longitude: 77.59 }]));
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

  await t.test('allowlist: agent token can access GET incidents, ambulances, hospitals, recommendations and POST assignments', async () => {
    const token = signAgentToken(secret);
    const beforeCalls = calls.length;

    // GET /api/incidents
    const incRes = await request('/api/incidents', 'GET', undefined, token);
    assert.equal(incRes.status, 200);
    assert.equal(incRes.body[0].id, 'INC-1');

    // GET /api/incidents/:id
    const singleInc = await request('/api/incidents/INC-1', 'GET', undefined, token);
    assert.equal(singleInc.status, 200);

    // GET /api/ambulances/available
    const ambRes = await request('/api/ambulances/available?lat=12.97&lng=77.59', 'GET', undefined, token);
    assert.equal(ambRes.status, 200);

    // GET /api/hospitals/scored/:incidentId
    const hospRes = await request('/api/hospitals/scored/INC-1', 'GET', undefined, token);
    assert.equal(hospRes.status, 200);

    // GET /api/assignments/recommendations/:incidentId
    const recRes = await request('/api/assignments/recommendations/INC-1', 'GET', undefined, token);
    assert.equal(recRes.status, 200);

    // POST /api/assignments
    const assignRes = await request('/api/assignments', 'POST', {
      incidentId: 'INC-1',
      ambulanceId: 'AMB-1',
      hospitalId: 'HOSP-1',
      notes: 'Automated test dispatch',
    }, token);
    assert.equal(assignRes.status, 201);
    assert.equal(assignRes.body.incident_id, 'INC-1');

    // Supabase /auth/v1/user should never be called for agent
    assert.equal(calls.slice(beforeCalls).some(c => c.path === '/auth/v1/user'), false);
  });

  await t.test('allowlist enforcement: non-allowlisted /api routes return 403 for agent token', async () => {
    const token = signAgentToken(secret);

    // GET /api/auth/me is NOT on the allowlist
    const meRes = await request('/api/auth/me', 'GET', undefined, token);
    assert.equal(meRes.status, 403);
    assert.match(meRes.body.error, /Agent access not permitted/i);

    // POST /api/incidents is NOT on the allowlist
    const postInc = await request('/api/incidents', 'POST', { incident_type: 'Medical' }, token);
    assert.equal(postInc.status, 403);

    // PATCH /api/incidents/:id/status is NOT on the allowlist
    const patchStatus = await request('/api/incidents/INC-1/status', 'PATCH', { status: 'RESOLVED' }, token);
    assert.equal(patchStatus.status, 403);

    // POST /api/auth/logout is NOT on the allowlist
    const logoutRes = await request('/api/auth/logout', 'POST', {}, token);
    assert.equal(logoutRes.status, 403);

    // Sub-path under /api/assignments that is not exact /api/assignments
    const assignSub = await request('/api/assignments/INC-1/cancel', 'POST', {}, token);
    assert.equal(assignSub.status, 403);
  });

  await t.test('tokens without exp or with non-number exp are rejected', async () => {
    // Missing exp
    const missingExp = signAgentToken(secret, {}, true);
    const res1 = await request('/api/incidents', 'GET', undefined, missingExp);
    assert.equal(res1.status, 401);

    // String exp
    const stringExp = signAgentToken(secret, { exp: '1899999999' });
    const res2 = await request('/api/incidents', 'GET', undefined, stringExp);
    assert.equal(res2.status, 401);

    // Null exp
    const nullExp = signAgentToken(secret, { exp: null });
    const res3 = await request('/api/incidents', 'GET', undefined, nullExp);
    assert.equal(res3.status, 401);
  });

  await t.test('tampered agent token fails signature and is rejected by upstream auth', async () => {
    const token = signAgentToken(secret);
    const tampered = token.slice(0, -5) + 'xxxxx';
    const res = await request('/api/incidents', 'GET', undefined, tampered);
    assert.equal(res.status, 401);
  });

  await t.test('expired agent token is rejected', async () => {
    const expired = signAgentToken(secret, { exp: Math.floor(Date.now() / 1000) - 100 });
    const res = await request('/api/incidents', 'GET', undefined, expired);
    assert.equal(res.status, 401);
  });

  await t.test('token with wrong sub or kind is rejected as agent token', async () => {
    const wrongSub = signAgentToken(secret, { sub: 'attacker' });
    const res1 = await request('/api/incidents', 'GET', undefined, wrongSub);
    assert.equal(res1.status, 401);

    const wrongKind = signAgentToken(secret, { kind: 'user' });
    const res2 = await request('/api/incidents', 'GET', undefined, wrongKind);
    assert.equal(res2.status, 401);
  });
});
