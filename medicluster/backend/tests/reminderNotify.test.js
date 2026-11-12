const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const { signToken, signAgentToken, requireAuth } = require('../middleware/auth');
const Reminder = require('../models/Reminder');
const ReminderNotification = require('../models/ReminderNotification');

const JWT_SECRET = 'reminder-notify-test-jwt-secret-at-least-32-chars';
const AGENT_SECRET = 'reminder-notify-test-agent-secret-at-least-32-chars';

async function setup(t) {
  await createTestDatabase(t);
  const previous = Object.fromEntries(['JWT_SECRET', 'AGENT_JWT_SECRET', 'ALLOWED_STAFF_EMAILS', 'ALLOWED_EMAIL_DOMAINS'].map(k => [k, process.env[k]]));
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AGENT_JWT_SECRET = AGENT_SECRET;
  delete process.env.ALLOWED_STAFF_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/api/reminders', require('../routes/reminderRoutes'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, payload) => {
    const res = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const reminder = await Reminder.create({
    patientId: 'patient-123',
    medicationName: 'Metformin',
    dosage: '500mg',
    times: ['08:00', '20:00'],
    frequency: 'daily',
    pillsLeft: 30,
  });

  return {
    call,
    reminder,
    agent: signAgentToken(),
    clinician: signToken({ _id: 'clinician-1' }),
  };
}

test('agent creates reminder notification', async t => {
  const { call, reminder, agent } = await setup(t);
  const payload = {
    patient_id: 'patient-123',
    date: '2026-11-13',
    time: '08:00',
    message: 'Please remember to take your Metformin 500mg scheduled for 08:00.',
    audit_id: 'audit-rem-1',
  };

  const res = await call('POST', `/api/reminders/${reminder._id}/notify`, agent, payload);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.reminderId, String(reminder._id));
  assert.equal(res.body.patientId, 'patient-123');
  assert.equal(res.body.date, '2026-11-13');
  assert.equal(res.body.time, '08:00');
  assert.equal(res.body.message, payload.message);
  assert.equal(res.body.auditId, 'audit-rem-1');
  assert.equal(res.body.status, 'sent');

  // Verify Reminder document itself was NOT modified (doses untouched)
  const remDoc = await Reminder.findById(reminder._id).lean();
  assert.equal(remDoc.dosage, '500mg');
  assert.equal(remDoc.pillsLeft, 30);
  assert.deepEqual(remDoc.times, ['08:00', '20:00']);
  assert.deepEqual(remDoc.doseLog, []);
});

test('duplicate notification updates existing record (idempotent)', async t => {
  const { call, reminder, agent } = await setup(t);
  const payload1 = {
    patient_id: 'patient-123',
    date: '2026-11-13',
    time: '08:00',
    message: 'Initial reminder.',
    audit_id: 'audit-1',
  };
  const payload2 = {
    patient_id: 'patient-123',
    date: '2026-11-13',
    time: '08:00',
    message: 'Updated reminder message.',
    audit_id: 'audit-2',
  };

  const res1 = await call('POST', `/api/reminders/${reminder._id}/notify`, agent, payload1);
  assert.equal(res1.status, 201);

  const res2 = await call('POST', `/api/reminders/${reminder._id}/notify`, agent, payload2);
  assert.equal(res2.status, 200);
  assert.equal(res2.body._id, res1.body._id);
  assert.equal(res2.body.message, 'Updated reminder message.');
  assert.equal(res2.body.auditId, 'audit-2');

  const count = await ReminderNotification.countDocuments({ reminderId: reminder._id });
  assert.equal(count, 1);
});

test('POST /notify with reminder_id in body works', async t => {
  const { call, reminder, agent } = await setup(t);
  const payload = {
    reminder_id: String(reminder._id),
    patient_id: 'patient-123',
    date: '2026-11-13',
    time: '20:00',
    message: 'Evening dose reminder.',
    audit_id: 'audit-evening',
  };

  const res = await call('POST', '/api/reminders/notify', agent, payload);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.reminderId, String(reminder._id));
});

test('clinician token cannot call agent notify endpoint', async t => {
  const { call, reminder, clinician } = await setup(t);
  const payload = {
    patient_id: 'patient-123',
    date: '2026-11-13',
    time: '08:00',
    message: 'Test message',
  };

  const res = await call('POST', `/api/reminders/${reminder._id}/notify`, clinician, payload);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Agent sign-in required' });
});

test('unauthenticated call is rejected', async t => {
  const { call, reminder } = await setup(t);
  const res = await call('POST', `/api/reminders/${reminder._id}/notify`, null, {});
  assert.equal(res.status, 401);
});

test('validation rejects invalid input', async t => {
  const { call, reminder, agent } = await setup(t);

  const cases = [
    { name: 'missing date', payload: { patient_id: 'p1', time: '08:00', message: 'm' } },
    { name: 'invalid date format', payload: { patient_id: 'p1', date: '13-11-2026', time: '08:00', message: 'm' } },
    { name: 'invalid time format', payload: { patient_id: 'p1', date: '2026-11-13', time: '8:0', message: 'm' } },
    { name: 'missing message', payload: { patient_id: 'p1', date: '2026-11-13', time: '08:00', message: '' } },
    { name: 'message too long', payload: { patient_id: 'p1', date: '2026-11-13', time: '08:00', message: 'x'.repeat(2001) } },
  ];

  for (const c of cases) {
    const res = await call('POST', `/api/reminders/${reminder._id}/notify`, agent, c.payload);
    assert.equal(res.status, 400, c.name);
  }
});

test('non-existent reminder returns 404', async t => {
  const { call, agent } = await setup(t);
  const payload = {
    patient_id: 'p1',
    date: '2026-11-13',
    time: '08:00',
    message: 'Hello',
  };
  const res = await call('POST', '/api/reminders/nonexistent123/notify', agent, payload);
  assert.equal(res.status, 404);
});
