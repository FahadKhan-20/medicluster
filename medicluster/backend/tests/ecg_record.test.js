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

test('ECG record upload endpoint validates inputs', async t => {
  const before = { ...process.env };
  process.env.JWT_SECRET = 'gateway-test-only-secret-longer-than-32-characters';
  t.after(() => {
    if (before.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = before.JWT_SECRET;
  });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ecg', require('../routes/ecgRoutes'));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const origin = await listen(t, app);
  const { signToken } = require('../middleware/auth');
  const token = signToken({ _id: 'medic_1' });

  // 1. Missing patient_id -> 400
  const noPatient = await fetch(`${origin}/api/ecg/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal: [] }),
  });
  assert.equal(noPatient.status, 400);
  assert.match((await noPatient.json()).error, /patient_id/);

  // 2. Bad signal shape -> 400
  const badSignal = await fetch(`${origin}/api/ecg/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient_id: 'p123', signal: [[1, 2, 3]] }),
  });
  assert.equal(badSignal.status, 400);
  assert.match((await badSignal.json()).error, /12 leads/);
});
