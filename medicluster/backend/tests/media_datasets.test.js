const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDatabase } = require('./helpers/supabaseTestDb');
const User = require('../models/User');
const PatientMedia = require('../models/PatientMedia');
const { signToken, signPatientToken } = require('../middleware/auth');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('media datasets proxy routes, authentication, role guards, and demo import', async t => {
  await createTestDatabase(t);

  const dummyImageBytes = Buffer.from('FAKE-JPEG-IMAGE-DATA-12345');

  // Mock upstream imaging server
  const imagingMock = express();
  imagingMock.use(express.json());

  imagingMock.get('/datasets', (_req, res) => {
    res.json([
      {
        id: 'chest-xray-pneumonia',
        name: 'Chest X-ray (Pneumonia)',
        modality: 'chest-xray',
        classes: ['Normal', 'Pneumonia'],
        counts: { Normal: 60, Pneumonia: 60, total: 120 },
        license: 'CC BY 4.0',
        citation: 'Kermany et al.',
      },
    ]);
  });

  imagingMock.get('/datasets/:name/samples', (req, res) => {
    assert.equal(req.params.name, 'chest-xray-pneumonia');
    res.json({
      dataset: req.params.name,
      class_filter: req.query.class || null,
      count: 1,
      samples: [
        {
          id: 'sample-001',
          class: 'Pneumonia',
          thumbnail_url: '/datasets/chest-xray-pneumonia/thumbnail/sample-001',
          image_url: '/datasets/chest-xray-pneumonia/image/sample-001',
        },
      ],
    });
  });

  imagingMock.get('/datasets/:name/image/:id', (req, res) => {
    if (req.params.id === 'not-found') {
      return res.status(404).json({ error: 'Sample not found' });
    }
    res.set('Content-Type', 'image/jpeg');
    res.send(dummyImageBytes);
  });

  imagingMock.get('/datasets/:name/thumbnail/:id', (_req, res) => {
    res.set('Content-Type', 'image/jpeg');
    res.send(dummyImageBytes);
  });

  imagingMock.post('/datasets/:name/analyze/:id', (req, res) => {
    assert.equal(req.params.name, 'chest-xray-pneumonia');
    assert.equal(req.params.id, 'sample-001');
    res.json({
      id: req.params.id,
      dataset: req.params.name,
      groundTruth: 'Pneumonia',
      predicted: 'Pneumonia',
      matches: true,
      score: 0.88,
      model: req.body.model || 'densenet121-res224-chex',
    });
  });

  imagingMock.post('/datasets/:name/benchmark', (req, res) => {
    assert.equal(req.params.name, 'chest-xray-pneumonia');
    res.json({
      dataset: 'chest-xray-pneumonia',
      model: req.body.model || 'densenet121-res224-chex',
      accuracy: 0.85,
      macro_f1: 0.84,
      confusion_matrix: [[50, 10], [8, 52]],
      classes: ['Normal', 'Pneumonia'],
    });
  });

  const imagingOrigin = await listen(t, imagingMock);

  const prevEnv = {
    CHEST_IMAGING_URL: process.env.CHEST_IMAGING_URL,
    ML_ENGINE_URL: process.env.ML_ENGINE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  process.env.CHEST_IMAGING_URL = imagingOrigin;
  process.env.ML_ENGINE_URL = imagingOrigin;
  process.env.JWT_SECRET = 'datasets-test-secret-must-be-at-least-32-chars-long';

  t.after(() => {
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // Mock supabase storage requests
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/storage/v1/')) {
      if (options.method === 'POST') {
        return Response.json({ Key: 'medicluster-media/files/test' });
      }
      return new Response(dummyImageBytes);
    }
    return originalFetch(url, options);
  };
  t.after(() => { global.fetch = originalFetch; });

  // Create users with different roles
  const doctorUser = await User.create({
    name: 'Dr. Jane Doctor',
    email: 'doctor@clinic.example',
    role: 'physician',
    passwordHash: 'hash',
  });

  const analystUser = await User.create({
    name: 'Analyst Alice',
    email: 'analyst@clinic.example',
    role: 'analyst',
    passwordHash: 'hash',
  });

  const nurseUser = await User.create({
    name: 'Nurse Bob',
    email: 'nurse@clinic.example',
    role: 'nurse',
    passwordHash: 'hash',
  });

  const doctorToken = signToken(doctorUser);
  const analystToken = signToken(analystUser);
  const nurseToken = signToken(nurseUser);
  const patientToken = signPatientToken('PT-DEMO-PATIENT');

  const app = express();
  app.use(express.json());
  app.use('/api/media', require('../routes/mediaRoutes'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const gatewayOrigin = await listen(t, app);

  const request = (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    return fetch(`${gatewayOrigin}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  await t.test('unauthenticated requests are rejected with 401', async () => {
    const res = await request('/api/media/datasets');
    assert.equal(res.status, 401);
  });

  await t.test('patient tokens are rejected with 403', async () => {
    const res = await request('/api/media/datasets', { token: patientToken });
    assert.equal(res.status, 403);
  });

  await t.test('doctor staff can list datasets and samples', async () => {
    const resList = await request('/api/media/datasets', { token: doctorToken });
    assert.equal(resList.status, 200);
    const list = await resList.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'chest-xray-pneumonia');

    const resSamples = await request('/api/media/datasets/chest-xray-pneumonia/samples?class=Pneumonia', {
      token: doctorToken,
    });
    assert.equal(resSamples.status, 200);
    const data = await resSamples.json();
    assert.equal(data.samples.length, 1);
    assert.equal(data.samples[0].class, 'Pneumonia');
  });

  await t.test('doctor staff can view sample images and thumbnails', async () => {
    const res = await request('/api/media/datasets/chest-xray-pneumonia/image/sample-001', {
      token: doctorToken,
    });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, dummyImageBytes);
  });

  await t.test('benchmark route requires doctor or physician role', async () => {
    // Nurse is clinician staff but not doctor/physician -> 403
    const resNurse = await request('/api/media/datasets/chest-xray-pneumonia/benchmark', {
      method: 'POST',
      token: nurseToken,
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'densenet121-res224-chex' },
    });
    assert.equal(resNurse.status, 403);

    // Analyst is clinician staff but not doctor/physician -> 403
    const resAnalyst = await request('/api/media/datasets/chest-xray-pneumonia/benchmark', {
      method: 'POST',
      token: analystToken,
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'densenet121-res224-chex' },
    });
    assert.equal(resAnalyst.status, 403);

    // Physician -> 200
    const resDoc = await request('/api/media/datasets/chest-xray-pneumonia/benchmark', {
      method: 'POST',
      token: doctorToken,
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'densenet121-res224-chex' },
    });
    assert.equal(resDoc.status, 200);
    const docData = await resDoc.json();
    assert.equal(docData.accuracy, 0.85);
  });

  await t.test('import route strictly enforces DEMO- prefix on patientId', async () => {
    // Non-DEMO patientId -> 400
    const resBad = await request('/api/media/datasets/chest-xray-pneumonia/import/sample-001', {
      method: 'POST',
      token: doctorToken,
      headers: { 'Content-Type': 'application/json' },
      body: { patientId: 'REAL-PATIENT-123' },
    });
    assert.equal(resBad.status, 400);
    const badJson = await resBad.json();
    assert.match(badJson.error, /DEMO-/);

    // Missing patientId -> 400
    const resEmpty = await request('/api/media/datasets/chest-xray-pneumonia/import/sample-001', {
      method: 'POST',
      token: doctorToken,
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(resEmpty.status, 400);

    // Valid DEMO- patientId -> 201 Created and saved to PatientMedia
    const resOk = await request('/api/media/datasets/chest-xray-pneumonia/import/sample-001', {
      method: 'POST',
      token: doctorToken,
      headers: { 'Content-Type': 'application/json' },
      body: { patientId: 'DEMO-DATASET-01' },
    });
    assert.equal(resOk.status, 201);
    const created = await resOk.json();
    assert.equal(created.patient_id, 'DEMO-DATASET-01');
    assert.match(created.original_name, /chest-xray-pneumonia_sample-001/);

    // Verify record in database
    const saved = await PatientMedia.findById(created._id);
    assert.ok(saved);
    assert.equal(saved.patient_id, 'DEMO-DATASET-01');
  });

  await t.test('analyze sample route runs inference and returns prediction vs ground truth', async () => {
    const res = await request('/api/media/datasets/chest-xray-pneumonia/analyze/sample-001', {
      method: 'POST',
      token: doctorToken,
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'densenet121-res224-chex' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, 'sample-001');
    assert.equal(data.groundTruth, 'Pneumonia');
    assert.equal(data.predicted, 'Pneumonia');
    assert.equal(data.matches, true);
    assert.equal(data.score, 0.88);
  });
});
