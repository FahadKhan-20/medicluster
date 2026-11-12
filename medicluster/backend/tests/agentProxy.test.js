const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const { signToken } = require('../middleware/auth');
const agentRoutes = require('../routes/agentRoutes');

const JWT_SECRET = 'agent-proxy-test-secret-at-least-32-chars';
const ADMIN_KEY = 'super-secret-admin-key-xyz-789';

async function startMockAgentCore() {
  const requests = [];
  let statusMode = 'ok'; // 'ok' | 'down' | 'leak'

  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    });

    if (statusMode === 'down') {
      req.socket.destroy();
      return;
    }

    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'healthy',
        components: { backend: 'healthy', ml: 'healthy', intelligence: 'healthy' },
        ...(statusMode === 'leak' ? { secretKeyEcho: req.headers['x-admin-key'], nested: { admin_key: req.headers['x-admin-key'] } } : {})
      }));
    }

    if (req.url.startsWith('/audit')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        items: [
          { id: 'aud-1', event: 'vitals_alert', outcome: 'executed', timestamp: new Date().toISOString() },
          ...(statusMode === 'leak' ? [{ id: 'leak', token: req.headers['x-admin-key'] }] : [])
        ]
      }));
    }

    if (req.url.startsWith('/control/stop')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        action: 'stop',
        status: 'stopped',
        ...(statusMode === 'leak' ? { admin_key: req.headers['x-admin-key'] } : {})
      }));
    }

    if (req.url.startsWith('/control/start')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ action: 'start', status: 'running' }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setStatusMode: mode => { statusMode = mode; },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })
  };
}

async function setupTestApp(t, mockCoreUrl) {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    AGENT_CORE_URL: process.env.AGENT_CORE_URL,
    AGENT_ADMIN_KEY: process.env.AGENT_ADMIN_KEY,
    ALLOWED_STAFF_EMAILS: process.env.ALLOWED_STAFF_EMAILS,
  };

  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_CORE_URL = mockCoreUrl;
  process.env.AGENT_ADMIN_KEY = ADMIN_KEY;
  delete process.env.ALLOWED_STAFF_EMAILS;

  t.after(() => {
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, token, body) => fetch(origin + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  return { call };
}

test('auth required: unauthenticated requests return 401', async t => {
  const mockCore = await startMockAgentCore();
  t.after(mockCore.close);

  const { call } = await setupTestApp(t, mockCore.url);

  for (const [method, path] of [
    ['GET', '/api/agent/health'],
    ['GET', '/api/agent/audit'],
    ['POST', '/api/agent/control/stop'],
    ['POST', '/api/agent/control/start'],
  ]) {
    const res = await call(method, path, null);
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

test('role checks: nurse, doctor, admin access enforcement', async t => {
  const mockCore = await startMockAgentCore();
  t.after(mockCore.close);

  const { call } = await setupTestApp(t, mockCore.url);

  const nurseToken = signToken({ _id: 'nurse-1', role: 'nurse' });
  const doctorToken = signToken({ _id: 'doctor-1', role: 'doctor' });
  const physicianToken = signToken({ _id: 'physician-1', role: 'physician' });
  const adminToken = signToken({ _id: 'admin-1', role: 'admin' });

  // 1. Nurse / unauthorized staff is forbidden on all agent endpoints
  for (const [method, path] of [
    ['GET', '/api/agent/health'],
    ['GET', '/api/agent/audit'],
    ['POST', '/api/agent/control/stop'],
  ]) {
    const res = await call(method, path, nurseToken);
    assert.equal(res.status, 403, `nurse should be 403 on ${method} ${path}`);
  }

  // 2. Doctor/Physician can view health & audit, but cannot stop/start agent
  for (const token of [doctorToken, physicianToken]) {
    const healthRes = await call('GET', '/api/agent/health', token);
    assert.equal(healthRes.status, 200, 'doctor should have access to health');

    const auditRes = await call('GET', '/api/agent/audit?limit=10', token);
    assert.equal(auditRes.status, 200, 'doctor should have access to audit');

    const controlRes = await call('POST', '/api/agent/control/stop', token);
    assert.equal(controlRes.status, 403, 'doctor should NOT have access to control');
  }

  // 3. Admin has access to health, audit, and control
  const adminHealth = await call('GET', '/api/agent/health', adminToken);
  assert.equal(adminHealth.status, 200);

  const adminAudit = await call('GET', '/api/agent/audit', adminToken);
  assert.equal(adminAudit.status, 200);

  const adminStop = await call('POST', '/api/agent/control/stop', adminToken);
  assert.equal(adminStop.status, 200);
  const stopBody = await adminStop.json();
  assert.equal(stopBody.status, 'stopped');

  const adminStart = await call('POST', '/api/agent/control/start', adminToken);
  assert.equal(adminStart.status, 200);
  const startBody = await adminStart.json();
  assert.equal(startBody.status, 'running');

  // Control action validation
  const invalidControl = await call('POST', '/api/agent/control/invalid', adminToken);
  assert.equal(invalidControl.status, 400);
});

test('upstream down returns 503', async t => {
  // Use a port where no server is listening
  const deadUrl = 'http://127.0.0.1:59999';
  const { call } = await setupTestApp(t, deadUrl);
  const adminToken = signToken({ _id: 'admin-1', role: 'admin' });

  for (const [method, path] of [
    ['GET', '/api/agent/health'],
    ['GET', '/api/agent/audit'],
    ['POST', '/api/agent/control/stop'],
  ]) {
    const res = await call(method, path, adminToken);
    assert.equal(res.status, 503, `${method} ${path} should return 503 when upstream is down`);
    const data = await res.json();
    assert.match(data.error, /service unavailable/i);
  }
});

test('admin key is forwarded to upstream but NEVER leaked in proxy responses', async t => {
  const mockCore = await startMockAgentCore();
  t.after(mockCore.close);

  // Set mock to attempt to leak key
  mockCore.setStatusMode('leak');

  const { call } = await setupTestApp(t, mockCore.url);
  const adminToken = signToken({ _id: 'admin-1', role: 'admin' });

  // 1. Health check
  const healthRes = await call('GET', '/api/agent/health', adminToken);
  assert.equal(healthRes.status, 200);
  const healthRaw = await healthRes.text();
  assert.equal(healthRaw.includes(ADMIN_KEY), false, 'health response must not contain admin key');

  // 2. Audit check
  const auditRes = await call('GET', '/api/agent/audit', adminToken);
  assert.equal(auditRes.status, 200);
  const auditRaw = await auditRes.text();
  assert.equal(auditRaw.includes(ADMIN_KEY), false, 'audit response must not contain admin key');

  // 3. Control check
  const controlRes = await call('POST', '/api/agent/control/stop', adminToken);
  assert.equal(controlRes.status, 200);
  const controlRaw = await controlRes.text();
  assert.equal(controlRaw.includes(ADMIN_KEY), false, 'control response must not contain admin key');

  // Verify that upstream did receive the x-admin-key header
  assert.ok(mockCore.requests.length >= 3);
  for (const req of mockCore.requests) {
    assert.equal(req.headers['x-admin-key'], ADMIN_KEY, 'upstream should receive x-admin-key header');
  }
});
