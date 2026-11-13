/**
 * Trauma-Bay Full-Screen Resuscitation Dashboard:
 * Self-contained static HTML page (no external build or bundler needed) served at GET /codeblue.
 */

import { calculateEgfr } from "./egfr.js";

export function renderCodeBluePage(_adminKey = ""): string {
  const demoEgfr = calculateEgfr(1.6, 64, "M");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MediCluster — Code Blue Resuscitation War Room</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 18 18%22%3E%3Crect x=%221%22 y=%221%22 width=%226%22 height=%226%22 fill=%22%2315171a%22/%3E%3Crect x=%2211%22 y=%221%22 width=%226%22 height=%226%22 fill=%22%2315171a%22/%3E%3Crect x=%221%22 y=%2211%22 width=%226%22 height=%226%22 fill=%22%2315171a%22/%3E%3Crect x=%2211%22 y=%2211%22 width=%226%22 height=%226%22 fill=%22%23e0703f%22/%3E%3C/svg%3E">
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #f3f5ee;
  --surface: #ffffff;
  --surface-raised: #eef2e8;
  --border: #e2e8db;
  --border-bright: #cfd9c4;
  --text: #17251d;
  --text-dim: #4a5a45;
  --text-muted: #7d8b76;
  --neon-green: #2f7d4f;
  --neon-red: #b8453c;
  --neon-amber: #b7791f;
  --neon-cyan: #ad633f;
  --neon-purple: #6d4c9f;
  --font-mono: 'IBM Plex Mono', 'SF Mono', Consolas, Menlo, monospace;
  --font-sans: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

header {
  background: var(--surface);
  border-bottom: 2px solid var(--border);
  padding: 12px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.alert-pulse {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--neon-red);
  box-shadow: 0 0 12px var(--neon-red);
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 6px var(--neon-red); }
  50% { transform: scale(1.15); box-shadow: 0 0 16px var(--neon-red); }
  100% { transform: scale(0.95); box-shadow: 0 0 6px var(--neon-red); }
}

.brand-title {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: 0.05em;
  color: #fff;
}

.patient-badge {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--surface-raised);
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border-bright);
  color: var(--text-dim);
}

.header-timers {
  display: flex;
  align-items: center;
  gap: 24px;
}

.timer-box {
  text-align: right;
  font-family: var(--font-mono);
}

.timer-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.08em;
}

.timer-value {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--neon-green);
  text-shadow: 0 0 8px rgba(0,255,136,0.3);
}

.timer-value.amber {
  color: var(--neon-amber);
  text-shadow: 0 0 8px rgba(255,183,0,0.3);
}

.timer-value.red {
  color: var(--neon-red);
  text-shadow: 0 0 8px rgba(255,51,102,0.3);
}

main {
  flex: 1;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
}

/* Oscilloscope Rhythm Strip */
.monitor-card {
  background: #020805;
  border: 2px solid #004422;
  border-radius: 10px;
  overflow: hidden;
  position: relative;
  box-shadow: inset 0 0 30px rgba(0,255,100,0.05);
}

.monitor-header {
  display: flex;
  justify-content: space-between;
  padding: 8px 16px;
  background: rgba(0,30,15,0.7);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--neon-green);
  border-bottom: 1px solid #004422;
}

canvas#ecgCanvas {
  display: block;
  width: 100%;
  height: 140px;
  background: transparent;
}

/* Consensus Action Card */
.consensus-card {
  background: var(--surface);
  border: 2px solid var(--neon-cyan);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: 0 0 25px rgba(0,229,255,0.15);
  position: relative;
  transition: all 0.3s ease;
}

.consensus-card.warning-glow {
  border-color: var(--neon-amber);
  box-shadow: 0 0 25px rgba(255,183,0,0.2);
}

.consensus-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.suggested-badge {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-transform: uppercase;
  background: rgba(0,229,255,0.12);
  color: var(--neon-cyan);
  padding: 6px 12px;
  border-radius: 20px;
  border: 1px solid var(--neon-cyan);
  font-weight: 600;
  letter-spacing: 0.05em;
}

.confidence-meter {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--text-dim);
}

.consensus-action {
  font-size: 1.8rem;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.rationale-text {
  font-size: 1.05rem;
  color: var(--text-dim);
  line-height: 1.5;
  border-left: 3px solid var(--neon-cyan);
  padding-left: 14px;
}

.warnings-box {
  background: rgba(255,183,0,0.08);
  border: 1px solid rgba(255,183,0,0.3);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 0.9rem;
  color: #ffcc66;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.consensus-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 8px;
}

.supporting-agents {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.supporting-agents span {
  color: var(--neon-green);
  font-weight: 600;
}

.confirm-btn {
  background: linear-gradient(135deg, #00b4d8, #0077b6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 700;
  padding: 12px 28px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 14px rgba(0,180,216,0.4);
  letter-spacing: 0.05em;
}

.confirm-btn:hover {
  background: linear-gradient(135deg, #0096c7, #023e8a);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(0,180,216,0.6);
}

.confirm-btn:active {
  transform: translateY(1px);
}

/* Three Specialist Agent Columns */
.specialists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}

.specialist-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.specialist-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 4px;
}

.badge.intensivist { background: rgba(0,255,136,0.15); color: var(--neon-green); }
.badge.pharmacologist { background: rgba(168,85,247,0.15); color: var(--neon-purple); }
.badge.cardiologist { background: rgba(0,229,255,0.15); color: var(--neon-cyan); }

.spec-recommendation {
  font-size: 1.1rem;
  font-weight: 600;
  color: #fff;
  line-height: 1.35;
}

.spec-rationale {
  font-size: 0.85rem;
  color: var(--text-dim);
  line-height: 1.45;
  flex: 1;
}

.spec-footer {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-muted);
  display: flex;
  justify-content: space-between;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

/* MediCluster theme overrides */
header { background: #17251d; border-bottom: 0; color: #f3f5ee; box-shadow: 0 8px 24px -16px rgba(23,37,29,.6); }
.brand-title { font-family: var(--font-sans); letter-spacing: -0.01em; font-size: 1.1rem; color: #fff; }
.brand-title small { display:block; font-size: .72rem; font-weight: 600; color: #d9a37f; letter-spacing: .02em; }
.patient-badge { background: rgba(243,245,238,.1); border-color: rgba(243,245,238,.2); color: #e7ecdf; font-size: .8rem; }
.timer-label { color: rgba(243,245,238,.6); }
.timer-value { color: #9fe0b5; text-shadow: none; }
.timer-value.amber { color: #f0c27a; text-shadow: none; }
.timer-value.red { color: #ff9b8f; text-shadow: none; }
.alert-pulse { box-shadow: 0 0 0 4px rgba(184,69,60,.25); }
.monitor-card { background: #0f1a14; border: 1px solid #22382b; border-radius: 16px; box-shadow: 0 12px 30px -18px rgba(23,37,29,.55); }
.monitor-header { background: #142219; color: #9fe0b5; border-bottom: 1px solid #22382b; }
.consensus-card { border: 1px solid var(--border-bright); border-left: 6px solid var(--neon-cyan); border-radius: 18px; box-shadow: 0 18px 40px -28px rgba(23,37,29,.45); }
.consensus-card.warning-glow { border-left-color: var(--neon-amber); box-shadow: 0 18px 40px -28px rgba(183,121,31,.5); }
.suggested-badge { background: #f6e3d6; border-color: #e7c3a8; color: #8a4a2b; font-family: var(--font-sans); }
.consensus-action { color: var(--text); font-weight: 800; }
.rationale-text { color: var(--text-dim); border-left-color: #e7c3a8; }
.warnings-box { background: #fbf1df; border-color: #ecd3a2; color: #7a5212; }
.supporting-agents span { color: var(--neon-green); }
.confirm-btn { background: #17251d; font-family: var(--font-sans); border-radius: 14px; box-shadow: 0 10px 22px -12px rgba(23,37,29,.7); letter-spacing: 0; }
.confirm-btn:hover { background: #22382b; box-shadow: 0 12px 26px -12px rgba(23,37,29,.8); }
.specialist-card { border-radius: 16px; box-shadow: 0 10px 26px -24px rgba(23,37,29,.5); }
.specialist-title { font-family: var(--font-sans); font-size: .95rem; }
.badge { font-family: var(--font-mono); font-weight: 700; border-radius: 999px; padding: 3px 10px; }
.badge.intensivist { background: #e2efe6; color: #2f7d4f; }
.badge.pharmacologist { background: #ece6f5; color: #6d4c9f; }
.badge.cardiologist { background: #f6e3d6; color: #8a4a2b; }
.spec-recommendation { color: var(--text); }
.cb-key { display:none; gap:8px; align-items:center; padding:10px 14px; border-radius:12px; background:#fbf1df; border:1px solid #ecd3a2; color:#7a5212; font-size:.9rem; }
.cb-key input { flex:1; min-width:180px; padding:8px 10px; border-radius:10px; border:1px solid #cfd9c4; font: inherit; }
.cb-key button { padding:8px 14px; border-radius:10px; border:0; background:#17251d; color:#fff; font: 600 .9rem var(--font-sans); cursor:pointer; }
.mc-brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:1.15rem; letter-spacing:-0.02em; color:#fff; }
.brand-sep { width:1px; height:28px; background:rgba(243,245,238,.2); }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="mc-brand"><svg class="mc-logo" viewBox="0 0 18 18" width="22" height="22" aria-hidden="true"><rect x="1" y="1" width="6" height="6" fill="#f3f5ee"/><rect x="11" y="1" width="6" height="6" fill="#f3f5ee"/><rect x="1" y="11" width="6" height="6" fill="#f3f5ee"/><rect x="11" y="11" width="6" height="6" fill="#e0703f"/></svg><span>MediCluster</span></div><div class="brand-sep"></div><div class="alert-pulse"></div><div class="brand-title"><small>Agent · Clinician confirms</small>Code Blue War Room</div>
    <div class="patient-badge" id="patientInfo">Patient: DEMO-ARREST-1 | 64M | eGFR: ${demoEgfr.egfr} (${demoEgfr.stage}) | Allergy: Iodine</div>
  </div>
  <div class="header-timers">
    <div class="timer-box">
      <div class="timer-label">Code Blue Elapsed</div>
      <div class="timer-value" id="codeTimer">00:00</div>
    </div>
    <div class="timer-box">
      <div class="timer-label">CPR 2-Min Cycle</div>
      <div class="timer-value amber" id="cprTimer">02:00</div>
    </div>
    <div class="timer-box">
      <div class="timer-label">Next Epi Due</div>
      <div class="timer-value" id="epiTimer">After Shock 2</div>
    </div>
    <div class="timer-box">
      <div class="timer-label">Shocks Given</div>
      <div class="timer-value red" id="shockCount">0</div>
    </div>
  </div>
</header>

<main>
  <!-- Oscilloscope Rhythm Strip -->
  <div class="cb-key" id="cbKey">Enter the agent admin key (from the console) to start the drill:
    <input id="cbKeyInput" type="password" placeholder="Admin key" autocomplete="off" onkeydown="if(event.key==='Enter')saveKey()">
    <button type="button" onclick="saveKey()">Start</button></div>
  <div class="monitor-card">
    <div class="monitor-header">
      <span id="leadLabel">LEAD II • 250 Hz • 25 mm/s • 10 mm/mV</span>
      <span id="rhythmStatus">DETECTING RHYTHM...</span>
      <span id="hrReadout">HR: -- BPM</span>
    </div>
    <canvas id="ecgCanvas" width="1400" height="140"></canvas>
  </div>

  <!-- Big Consensus Action Card -->
  <div class="consensus-card" id="consensusCard">
    <div class="consensus-header">
      <div class="suggested-badge" id="cardStatusBadge">Suggested — Clinician Confirms</div>
      <div class="confidence-meter" id="cardConfidence">Consensus Confidence: --%</div>
    </div>
    <div class="consensus-action" id="cardAction">Initializing Code Blue Resuscitation Advisory...</div>
    <div class="rationale-text" id="cardRationale">Analyzing real-time multi-agent clinical consensus.</div>
    <div class="warnings-box" id="cardWarnings" style="display:none;"></div>
    <div class="consensus-footer">
      <div class="supporting-agents" id="supportingAgents">Supporting Specialists: --</div>
      <button class="confirm-btn" id="confirmBtn" onclick="confirmAction()">Confirm action</button>
    </div>
  </div>

  <!-- Three Specialist Agent Columns -->
  <div class="specialists-grid">
    <!-- Intensivist -->
    <div class="specialist-card">
      <div class="specialist-title">
        <span>INTENSIVIST AGENT</span>
        <span class="badge intensivist">ACLS PROTOCOL</span>
      </div>
      <div class="spec-recommendation" id="intensivistAction">Evaluating ACLS timing...</div>
      <div class="spec-rationale" id="intensivistRationale">Monitoring CPR cycle, shock history, and drug intervals.</div>
      <div class="spec-footer">
        <span id="intensivistConf">Confidence: --</span>
        <span id="intensivistStatus">Active</span>
      </div>
    </div>

    <!-- Pharmacologist -->
    <div class="specialist-card">
      <div class="specialist-title">
        <span>PHARMACOLOGIST AGENT</span>
        <span class="badge pharmacologist">RENAL & ALLERGY SAFETY</span>
      </div>
      <div class="spec-recommendation" id="pharmAction">Checking medications...</div>
      <div class="spec-rationale" id="pharmRationale">eGFR via CKD-EPI 2021, allergy cross-matching, drug interactions.</div>
      <div class="spec-footer">
        <span id="pharmConf">Confidence: --</span>
        <span id="pharmStatus">Active</span>
      </div>
    </div>

    <!-- Cardiologist -->
    <div class="specialist-card">
      <div class="specialist-title">
        <span>CARDIOLOGIST AGENT</span>
        <span class="badge cardiologist">ARREST RHYTHM MODEL</span>
      </div>
      <div class="spec-recommendation" id="cardioAction">Analyzing rhythm strip...</div>
      <div class="spec-rationale" id="cardioRationale">1D-CNN classifier for VF, VT, Asystole, Organized rhythm.</div>
      <div class="spec-footer">
        <span id="cardioConf">Confidence: --</span>
        <span id="cardioModel">arrest-rhythm-v1</span>
      </div>
    </div>
  </div>
</main>

<script>
let currentSessionId = null;
let currentAction = "";
// Admin key comes from the agent console session on this origin; it is never embedded in the page.
let adminKey = '';
try { adminKey = sessionStorage.getItem('adminKey') || localStorage.getItem('adminKey') || ''; } catch (e) {}
let headers = { 'x-admin-key': adminKey, 'content-type': 'application/json' };
function needKey() { document.getElementById('cbKey').style.display = 'flex'; }
function saveKey() {
  const v = document.getElementById('cbKeyInput').value.trim();
  if (!v) return;
  adminKey = v; headers = { 'x-admin-key': adminKey, 'content-type': 'application/json' };
  try { sessionStorage.setItem('adminKey', v); } catch (e) {}
  document.getElementById('cbKey').style.display = 'none';
  initSession();
}

// Waveform Oscilloscope buffer
const canvas = document.getElementById('ecgCanvas');
const ctx = canvas.getContext('2d');
let waveBuffer = [];
let sweepX = 0;

function drawGrid() {
  ctx.strokeStyle = 'rgba(159, 224, 181, 0.08)';
  ctx.lineWidth = 1;
  const step = 20;
  for (let x = 0; x < canvas.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function updateWaveform(newSamples) {
  if (!newSamples || !newSamples.length) return;
  waveBuffer.push(...newSamples);
  if (waveBuffer.length > 2000) waveBuffer = waveBuffer.slice(-2000);
}

function renderCanvas() {
  // Clear strip ahead of sweep bar
  const midY = canvas.height / 2;
  const scaleY = canvas.height / 3;

  ctx.fillStyle = 'rgba(15, 26, 20, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  if (waveBuffer.length > 1) {
    ctx.strokeStyle = '#9fe0b5';
    ctx.lineWidth = 2.2;
    ctx.shadowColor = 'rgba(159,224,181,.5)';
    ctx.shadowBlur = 8;
    ctx.beginPath();

    const startIdx = Math.max(0, waveBuffer.length - canvas.width);
    for (let i = 0; i < canvas.width && (startIdx + i) < waveBuffer.length; i++) {
      const v = waveBuffer[startIdx + i];
      const y = midY - v * scaleY;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  requestAnimationFrame(renderCanvas);
}
requestAnimationFrame(renderCanvas);

function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

async function initSession() {
  try {
    const res = await fetch('/codeblue/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ patientId: 'trauma-bay-pt-101', scenario: true })
    });
    if (res.status === 401 || res.status === 403) { needKey(); return; }
    if (res.ok) {
      const data = await res.json();
      currentSessionId = data.session.id;
      poll();
    }
  } catch (err) {
    console.error("Init session failed", err);
  }
}

async function poll() {
  if (!currentSessionId) return;
  try {
    const res = await fetch('/codeblue/' + currentSessionId + '/card', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const tel = data.telemetry;
    const card = data.card;

    // Patient Info
    if (tel.patientSummary) {
      document.getElementById('patientInfo').innerText = tel.patientSummary;
    }

    // Timers
    document.getElementById('codeTimer').innerText = formatTime(tel.codeTimeSeconds);
    document.getElementById('cprTimer').innerText = formatTime(tel.cprRemainingSeconds);

    const epiEl = document.getElementById('epiTimer');
    if (tel.nextEpiText) {
      epiEl.innerText = tel.nextEpiText;
      epiEl.className = tel.nextEpiText === 'DUE NOW' ? 'timer-value red' : 'timer-value';
    } else if (tel.nextEpiDueInSeconds === null) {
      epiEl.innerText = 'After Shock 2';
      epiEl.className = 'timer-value';
    } else if (tel.nextEpiDueInSeconds === 0) {
      epiEl.innerText = 'DUE NOW';
      epiEl.className = 'timer-value red';
    } else {
      epiEl.innerText = formatTime(tel.nextEpiDueInSeconds);
      epiEl.className = 'timer-value';
    }

    document.getElementById('shockCount').innerText = tel.shockCount;

    // Monitor Header
    document.getElementById('rhythmStatus').innerText = tel.currentRhythm + ' — ' + (tel.hasPulse ? 'PULSE PRESENT' : 'PULSELESS');
    document.getElementById('hrReadout').innerText = 'HR: ' + tel.heartRateBpm + ' BPM';

    // Waveform
    if (tel.monitorWaveform) updateWaveform(tel.monitorWaveform);

    // Consensus Card
    if (card) {
      currentAction = card.action;
      document.getElementById('cardAction').innerText = card.action;
      document.getElementById('cardRationale').innerText = card.rationale || 'Specialist consensus agreement.';
      document.getElementById('cardConfidence').innerText = 'Consensus Confidence: ' + Math.round(card.confidence * 100) + '%';
      document.getElementById('supportingAgents').innerHTML = 'Supporting: <span>' + card.supporting_agents.join(', ') + '</span>';

      const warnDiv = document.getElementById('cardWarnings');
      if (card.warnings && card.warnings.length) {
        warnDiv.style.display = 'block';
        warnDiv.innerHTML = card.warnings.map(w => '<div>⚠️ ' + w + '</div>').join('');
        document.getElementById('consensusCard').classList.add('warning-glow');
      } else {
        warnDiv.style.display = 'none';
        document.getElementById('consensusCard').classList.remove('warning-glow');
      }
    }

    // Specialist Panels
    const spec = tel.specialists;
    if (spec.intensivist) {
      document.getElementById('intensivistAction').innerText = spec.intensivist.action;
      document.getElementById('intensivistRationale').innerText = spec.intensivist.rationale;
      document.getElementById('intensivistConf').innerText = 'Confidence: ' + Math.round(spec.intensivist.confidence * 100) + '%';
    }
    if (spec.pharmacologist) {
      document.getElementById('pharmAction').innerText = spec.pharmacologist.action;
      document.getElementById('pharmRationale').innerText = spec.pharmacologist.rationale;
      document.getElementById('pharmConf').innerText = 'Confidence: ' + Math.round(spec.pharmacologist.confidence * 100) + '%';
    }
    if (spec.cardiologist) {
      document.getElementById('cardioAction').innerText = spec.cardiologist.action;
      document.getElementById('cardioRationale').innerText = spec.cardiologist.rationale;
      document.getElementById('cardioConf').innerText = 'Confidence: ' + Math.round(spec.cardiologist.confidence * 100) + '%';
    }

  } catch (err) {
    console.error("Poll error", err);
  } finally {
    setTimeout(poll, 1000);
  }
}

async function confirmAction() {
  if (!currentSessionId || !currentAction) return;
  const btn = document.getElementById('confirmBtn');
  btn.innerText = "Confirming…";
  try {
    const res = await fetch('/codeblue/' + currentSessionId + '/ack', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: currentAction })
    });
    if (res.ok) {
      btn.innerText = "Confirmed ✓";
      setTimeout(() => { btn.innerText = "Confirm action"; }, 1200);
    }
  } catch (err) {
    console.error("Ack error", err);
    btn.innerText = "Confirm action";
  }
}

// Auto init on load
if (adminKey) initSession(); else needKey();
</script>
</body>
</html>`;
}
