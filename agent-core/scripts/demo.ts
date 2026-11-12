/**
 * agent-core/scripts/demo.ts
 * One-click demo runner for MediCluster Agent-Core.
 *
 * Steps:
 *  1. Imaging: upload synthetic chest X-ray PNG (256x256 grayscale) for demo patient
 *  2. Radar/Sepsis: insert deteriorating vitals series (HR rising, BP falling, temp rising, RR rising over 8 readings)
 *  3. ECG: post synthetic 10s 12-lead ECG record
 *  4. Dispatch: create synthetic SOS incident with demo location
 *  5. Code Blue: POST /codeblue/start { patientId: "DEMO-P001", scenario: "vf" } and print consensus card
 *
 * Flags:
 *  --only <step>    Run only a specific step (1..5 or step name)
 *  --dry-run        Print requests without sending network calls
 *  --patient <id>   Target demo patient ID (must start with DEMO-)
 *  --timeout <sec>  Timeout per step in seconds (default 90s)
 */

import * as zlib from "node:zlib";
import process from "node:process";

export interface DemoConfig {
  backendUrl: string;
  dispatchUrl: string;
  agentUrl: string;
  agentAdminKey: string;
  staffEmail?: string;
  staffPassword?: string;
  patientId: string;
  dryRun: boolean;
  onlyStep?: number | string;
  timeoutSec: number;
  fetchFn: typeof fetch;
}

export interface StepResult {
  step: number;
  name: string;
  outcome: string;
  auditId: string;
  seconds: number;
  details?: string;
}

export interface DemoRunResult {
  patientId: string;
  dryRun: boolean;
  results: StepResult[];
  success: boolean;
}

/**
 * Refuse to run if patientId does not start with "DEMO-".
 */
export function validatePatientId(patientId: string): void {
  if (!patientId || typeof patientId !== "string" || !patientId.startsWith("DEMO-")) {
    throw new Error(
      `[SECURITY] Refusing to run with patientId "${patientId}". All demo runs require a patient ID starting with "DEMO-".`
    );
  }
}

/**
 * Generate a 256x256 grayscale PNG in memory without external libraries.
 */
export function generateSyntheticChestXrayPng(width = 256, height = 256): Buffer {
  function crc32(buf: Buffer): number {
    let table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return (crc ^ (-1)) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "binary");
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }

  // 8-byte PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk (width, height, bitDepth=8, colorType=0 (grayscale), comp=0, filter=0, interlace=0)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 0;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk("IHDR", ihdrData);

  // Scanlines: 1 filter byte (0 = none) + width bytes per row
  const raw = Buffer.alloc(height * (1 + width));
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width);
    raw[rowOffset] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      // Synthetic chest X-ray pattern:
      // Dark bilateral lung fields (low attenuation), bright central spine/mediastinum (high attenuation)
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      let intensity = 40; // baseline dark lung

      // Spine & mediastinum in the center
      if (dx < 22 && dy < 100) intensity += 140;
      // Cardiac silhouette slightly to patient left (image right)
      else if (x > cx - 10 && x < cx + 45 && y > cy - 20 && y < cy + 60) intensity += 100;
      // Bilateral clavicles and ribs
      else if ((y > 45 && y < 55) || (y % 28 < 4 && dy < 90 && dx < 95)) intensity += 55;
      // Outer thoracic cage
      else if (dx > 95) intensity += 80;

      raw[rowOffset + 1 + x] = Math.min(255, Math.max(0, intensity));
    }
  }

  const idat = makeChunk("IDAT", zlib.deflateSync(raw));
  const iend = makeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/**
 * Deteriorating vitals series over 8 readings:
 * HR rising (80 -> 150), BP falling (125/82 -> 70/45), Temp rising (37.0 -> 40.0), RR rising (16 -> 38).
 */
export function generateDeterioratingVitals(patientId: string, count = 8) {
  validatePatientId(patientId);
  const now = Date.now();
  const readings = [];

  const hrSteps = [80, 90, 100, 110, 120, 130, 140, 150];
  const sbpSteps = [125, 120, 115, 110, 100, 90, 80, 70];
  const dbpSteps = [82, 80, 76, 72, 65, 58, 52, 45];
  const tempSteps = [37.0, 37.3, 37.6, 38.0, 38.5, 38.9, 39.4, 40.0];
  const rrSteps = [16, 18, 20, 22, 26, 30, 34, 38];
  const spo2Steps = [98, 97, 96, 95, 93, 91, 89, 88];

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(now - (count - 1 - i) * 3600 * 1000).toISOString();
    readings.push({
      timestamp,
      heart_rate: hrSteps[i],
      systolic_bp: sbpSteps[i],
      diastolic_bp: dbpSteps[i],
      temperature: tempSteps[i],
      respiratory_rate: rrSteps[i],
      spo2: spo2Steps[i],
      synthetic_note: `DEMO deteriorating vitals reading ${i + 1}/${count} for ${patientId}`,
    });
  }

  return readings;
}

/**
 * Synthetic 10s 12-lead ECG record: 12 leads, 1000 samples each.
 */
export function generateSyntheticEcg12Lead(patientId: string) {
  validatePatientId(patientId);
  const leads = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];
  const numSamples = 1000; // 10s at 100Hz

  const signal: number[][] = [];
  for (let l = 0; l < leads.length; l++) {
    const leadSignal: number[] = new Array(numSamples);
    const leadPhase = (l * Math.PI) / 6;
    for (let t = 0; t < numSamples; t++) {
      // Synthetic QRS-like ECG waveform using periodic trigonometric synthesis
      const phase = (t % 100) / 100; // 1 beat per second = 60 BPM
      let val = 0.05 * Math.sin(phase * 2 * Math.PI + leadPhase);
      if (phase >= 0.15 && phase < 0.2) {
        val += 0.15 * Math.sin((phase - 0.15) * 20 * Math.PI); // P wave
      } else if (phase >= 0.35 && phase < 0.42) {
        // QRS complex
        const qrs = (phase - 0.35) / 0.07;
        if (qrs < 0.2) val -= 0.2; // Q wave
        else if (qrs < 0.7) val += 1.2; // R wave
        else val -= 0.4; // S wave
      } else if (phase >= 0.55 && phase < 0.75) {
        val += 0.3 * Math.sin((phase - 0.55) * 5 * Math.PI); // T wave
      }
      leadSignal[t] = Math.round(val * 1000) / 1000;
    }
    signal.push(leadSignal);
  }

  return {
    patient_id: patientId,
    signal,
    lead_order: leads,
    device: "DEMO Synthetic 12-Lead ECG Device",
    recordedAt: new Date().toISOString(),
    is_demo: true,
  };
}

/**
 * Synthetic SOS incident for Dispatch.
 */
export function generateSyntheticSosIncident(patientId: string) {
  validatePatientId(patientId);
  return {
    incident_type: "MEDICAL_EMERGENCY",
    severity: "CRITICAL",
    location_address: "DEMO Location: St. Jude Trauma Wing 4B",
    location_lat: 37.7749,
    location_lng: -122.4194,
    caller_name: "DEMO Clinician Dr. Carter",
    caller_phone: "+15551234567",
    patients_count: 1,
    description: `DEMO Synthetic SOS: Patient ${patientId} experiencing acute collapse with ventricular arrhythmia`,
    is_sos: true,
  };
}

/**
 * Format the end-of-run summary table.
 */
export function formatSummaryTable(results: StepResult[]): string {
  const colStep = 22;
  const colOutcome = 12;
  const colAudit = 28;
  const colSec = 9;

  const sepLine = `+${"-".repeat(colStep + 2)}+${"-".repeat(colOutcome + 2)}+${"-".repeat(colAudit + 2)}+${"-".repeat(colSec + 2)}+`;
  const header = `| ${"Step".padEnd(colStep)} | ${"Outcome".padEnd(colOutcome)} | ${"Audit ID".padEnd(colAudit)} | ${"Seconds".padStart(colSec)} |`;

  const rows = results.map((r) => {
    const stepStr = `${r.step}. ${r.name}`.slice(0, colStep).padEnd(colStep);
    const outcomeStr = r.outcome.slice(0, colOutcome).padEnd(colOutcome);
    const auditStr = r.auditId.slice(0, colAudit).padEnd(colAudit);
    const secStr = `${r.seconds.toFixed(1)}s`.padStart(colSec);
    return `| ${stepStr} | ${outcomeStr} | ${auditStr} | ${secStr} |`;
  });

  return [
    "",
    "================================================================================",
    "                        MEDICLUSTER DEMO RUN SUMMARY                            ",
    "================================================================================",
    sepLine,
    header,
    sepLine,
    ...rows,
    sepLine,
    "",
  ].join("\n");
}

/**
 * Poll GET /audit?since=... until an entry appears or timeout expires.
 * Never hangs!
 */
export async function pollAudit(
  agentUrl: string,
  adminKey: string,
  sinceIso: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  pollIntervalMs = 1000
): Promise<{ outcome: string; auditId: string; durationSec: number }> {
  const start = Date.now();
  const url = `${agentUrl.replace(/\/+$/, "")}/audit?since=${encodeURIComponent(sinceIso)}&limit=10`;

  while (Date.now() - start < timeoutMs) {
    try {
      const headers: Record<string, string> = {};
      if (adminKey) headers["x-admin-key"] = adminKey;

      const res = await fetchFn(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(10000, timeoutMs)),
      });

      if (res.ok) {
        const list = await res.json().catch(() => null);
        if (Array.isArray(list) && list.length > 0) {
          const entry = list[0];
          const auditId = String(entry._id || entry.id || "found");
          const outcome = String(entry.outcome || "executed");
          const durationSec = Math.max(0.1, (Date.now() - start) / 1000);
          return { outcome, auditId, durationSec };
        }
      }
    } catch {
      // ignore network errors and retry until timeout
    }

    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) break;
    const sleepMs = Math.min(pollIntervalMs, timeoutMs - elapsed);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  const durationSec = Math.max(0.1, (Date.now() - start) / 1000);
  return { outcome: "timeout", auditId: "none", durationSec };
}

/**
 * Main Demo Runner
 */
export async function runDemo(config: DemoConfig): Promise<DemoRunResult> {
  validatePatientId(config.patientId);

  const results: StepResult[] = [];
  const log = (msg: string) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
  };

  log(`🚀 Starting MediCluster Demo for Patient: ${config.patientId} (dryRun: ${config.dryRun})`);

  let staffToken = "";
  async function ensureStaffLogin(): Promise<string> {
    if (config.dryRun) {
      log(`[DRY-RUN] Staff Login: POST ${config.backendUrl}/api/auth/login for ${config.staffEmail || "DEMO_STAFF"}`);
      return "mock-dry-run-staff-token";
    }
    if (staffToken) return staffToken;

    if (!config.staffEmail || !config.staffPassword) {
      throw new Error(
        "DEMO_STAFF_EMAIL and DEMO_STAFF_PASSWORD must be provided via environment variables for live staff operations."
      );
    }

    log(`Logging in demo staff: ${config.staffEmail}`);
    const res = await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: config.staffEmail, password: config.staffPassword }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Staff login failed with HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    staffToken = data.token;
    return staffToken;
  }

  const stepsToRun = [
    { step: 1, key: "imaging", name: "Imaging" },
    { step: 2, key: "radar", altKey: "sepsis", name: "Radar/Sepsis" },
    { step: 3, key: "ecg", name: "ECG" },
    { step: 4, key: "dispatch", name: "Dispatch" },
    { step: 5, key: "codeblue", name: "Code Blue" },
  ];

  function shouldRun(s: { step: number; key: string; altKey?: string }): boolean {
    if (!config.onlyStep) return true;
    const filter = String(config.onlyStep).trim().toLowerCase();
    if (filter === String(s.step)) return true;
    if (filter === s.key.toLowerCase()) return true;
    if (s.altKey && filter === s.altKey.toLowerCase()) return true;
    return false;
  }

  // --------------------------------------------------------------------------
  // STEP 1: Imaging
  // --------------------------------------------------------------------------
  if (shouldRun(stepsToRun[0])) {
    const s = stepsToRun[0];
    const stepStart = new Date().toISOString();
    log(`▶ Step ${s.step}: ${s.name} starting...`);

    if (config.dryRun) {
      log(`[DRY-RUN] Step 1: Generate 256x256 grayscale PNG (size: ~5.7 KB)`);
      log(`[DRY-RUN] Step 1: POST ${config.backendUrl}/api/media/upload (multipart: file, patient_id="${config.patientId}")`);
      results.push({
        step: s.step,
        name: s.name,
        outcome: "dry-run",
        auditId: "(dry-run)",
        seconds: 0.0,
      });
    } else {
      try {
        const token = await ensureStaffLogin();
        const pngBuf = generateSyntheticChestXrayPng(256, 256);

        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(pngBuf)], { type: "image/png" }), "DEMO-chest-xray.png");
        form.append("patient_id", config.patientId);

        const uploadRes = await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/media/upload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });

        if (!uploadRes.ok) {
          const err = await uploadRes.text().catch(() => "");
          log(`⚠️ Step 1 upload returned HTTP ${uploadRes.status}: ${err.slice(0, 150)}`);
        } else {
          log(`Step 1: Synthetic chest X-ray uploaded successfully.`);
        }

        const audit = await pollAudit(
          config.agentUrl,
          config.agentAdminKey,
          stepStart,
          config.timeoutSec * 1000,
          config.fetchFn
        );
        log(`✓ Step ${s.step}: ${s.name} outcome: ${audit.outcome} (audit: ${audit.auditId}) [${audit.durationSec.toFixed(1)}s]`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: audit.outcome,
          auditId: audit.auditId,
          seconds: audit.durationSec,
        });
      } catch (err: any) {
        log(`✗ Step ${s.step}: ${s.name} error: ${err.message}`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: "failed",
          auditId: "none",
          seconds: 0.1,
          details: err.message,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // STEP 2: Radar / Sepsis
  // --------------------------------------------------------------------------
  if (shouldRun(stepsToRun[1])) {
    const s = stepsToRun[1];
    const stepStart = new Date().toISOString();
    log(`▶ Step ${s.step}: ${s.name} starting...`);

    const vitals = generateDeterioratingVitals(config.patientId, 8);

    if (config.dryRun) {
      log(`[DRY-RUN] Step 2: Generated 8 deteriorating vital readings (HR rising 80->150, BP falling 125/82->70/45, Temp rising 37->40, RR rising 16->38)`);
      log(`[DRY-RUN] Step 2: POST ${config.backendUrl}/api/intelligence/radar/sessions { patientId: "${config.patientId}", source: "manual" }`);
      log(`[DRY-RUN] Step 2: POST ${config.backendUrl}/api/intelligence/radar/sessions/:id/readings { readings: [8 items] }`);
      results.push({
        step: s.step,
        name: s.name,
        outcome: "dry-run",
        auditId: "(dry-run)",
        seconds: 0.0,
      });
    } else {
      try {
        const token = await ensureStaffLogin();
        // 1. Create a manual radar session
        const sessionRes = await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/intelligence/radar/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ patientId: config.patientId, source: "manual" }),
        });

        let sessionId = "";
        if (sessionRes.ok) {
          const sessionData = (await sessionRes.json().catch(() => ({}))) as any;
          sessionId = sessionData.id;
        }

        // 2. Insert readings into radar session if available
        if (sessionId) {
          await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/intelligence/radar/sessions/${sessionId}/readings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ readings: vitals }),
          });
        }

        // 3. Also post BP readings into patient-app readings route for sepsis workflow
        for (const r of vitals) {
          await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/patient-app/${config.patientId}/readings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              type: "bp",
              value: r.systolic_bp,
              diastolic: r.diastolic_bp,
              takenAt: r.timestamp,
            }),
          }).catch(() => {});
        }

        log(`Step 2: Deteriorating vitals series submitted.`);
        const audit = await pollAudit(
          config.agentUrl,
          config.agentAdminKey,
          stepStart,
          config.timeoutSec * 1000,
          config.fetchFn
        );
        log(`✓ Step ${s.step}: ${s.name} outcome: ${audit.outcome} (audit: ${audit.auditId}) [${audit.durationSec.toFixed(1)}s]`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: audit.outcome,
          auditId: audit.auditId,
          seconds: audit.durationSec,
        });
      } catch (err: any) {
        log(`✗ Step ${s.step}: ${s.name} error: ${err.message}`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: "failed",
          auditId: "none",
          seconds: 0.1,
          details: err.message,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // STEP 3: ECG
  // --------------------------------------------------------------------------
  if (shouldRun(stepsToRun[2])) {
    const s = stepsToRun[2];
    const stepStart = new Date().toISOString();
    log(`▶ Step ${s.step}: ${s.name} starting...`);

    const ecgPayload = generateSyntheticEcg12Lead(config.patientId);

    if (config.dryRun) {
      log(`[DRY-RUN] Step 3: Generated 10s 12-lead ECG signal (12 leads x 1000 samples)`);
      log(`[DRY-RUN] Step 3: POST ${config.backendUrl}/api/ecg/upload { patient_id: "${config.patientId}", signal: [12x1000] }`);
      results.push({
        step: s.step,
        name: s.name,
        outcome: "dry-run",
        auditId: "(dry-run)",
        seconds: 0.0,
      });
    } else {
      try {
        const token = await ensureStaffLogin();
        const ecgRes = await config.fetchFn(`${config.backendUrl.replace(/\/+$/, "")}/api/ecg/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(ecgPayload),
        });

        if (!ecgRes.ok) {
          const err = await ecgRes.text().catch(() => "");
          log(`⚠️ Step 3 ECG upload returned HTTP ${ecgRes.status}: ${err.slice(0, 150)}`);
        } else {
          log(`Step 3: Synthetic 12-lead ECG record uploaded successfully.`);
        }

        const audit = await pollAudit(
          config.agentUrl,
          config.agentAdminKey,
          stepStart,
          config.timeoutSec * 1000,
          config.fetchFn
        );
        log(`✓ Step ${s.step}: ${s.name} outcome: ${audit.outcome} (audit: ${audit.auditId}) [${audit.durationSec.toFixed(1)}s]`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: audit.outcome,
          auditId: audit.auditId,
          seconds: audit.durationSec,
        });
      } catch (err: any) {
        log(`✗ Step ${s.step}: ${s.name} error: ${err.message}`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: "failed",
          auditId: "none",
          seconds: 0.1,
          details: err.message,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // STEP 4: Dispatch
  // --------------------------------------------------------------------------
  if (shouldRun(stepsToRun[3])) {
    const s = stepsToRun[3];
    const stepStart = new Date().toISOString();
    log(`▶ Step ${s.step}: ${s.name} starting...`);

    const sosPayload = generateSyntheticSosIncident(config.patientId);

    if (config.dryRun) {
      log(`[DRY-RUN] Step 4: Generated synthetic SOS incident for ${config.patientId} at (${sosPayload.location_lat}, ${sosPayload.location_lng})`);
      log(`[DRY-RUN] Step 4: POST ${config.dispatchUrl}/api/incidents ${JSON.stringify(sosPayload)}`);
      results.push({
        step: s.step,
        name: s.name,
        outcome: "dry-run",
        auditId: "(dry-run)",
        seconds: 0.0,
      });
    } else {
      try {
        const token = await ensureStaffLogin().catch(() => "");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const incRes = await config.fetchFn(`${config.dispatchUrl.replace(/\/+$/, "")}/api/incidents`, {
          method: "POST",
          headers,
          body: JSON.stringify(sosPayload),
        });

        if (!incRes.ok) {
          const err = await incRes.text().catch(() => "");
          log(`⚠️ Step 4 Dispatch incident creation returned HTTP ${incRes.status}: ${err.slice(0, 150)}`);
        } else {
          log(`Step 4: Synthetic SOS incident created.`);
        }

        const audit = await pollAudit(
          config.agentUrl,
          config.agentAdminKey,
          stepStart,
          config.timeoutSec * 1000,
          config.fetchFn
        );
        log(`✓ Step ${s.step}: ${s.name} outcome: ${audit.outcome} (audit: ${audit.auditId}) [${audit.durationSec.toFixed(1)}s]`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: audit.outcome,
          auditId: audit.auditId,
          seconds: audit.durationSec,
        });
      } catch (err: any) {
        log(`✗ Step ${s.step}: ${s.name} error: ${err.message}`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: "failed",
          auditId: "none",
          seconds: 0.1,
          details: err.message,
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // STEP 5: Code Blue
  // --------------------------------------------------------------------------
  if (shouldRun(stepsToRun[4])) {
    const s = stepsToRun[4];
    const stepStart = new Date().toISOString();
    log(`▶ Step ${s.step}: ${s.name} starting...`);

    const codeBluePayload = {
      patientId: config.patientId,
      scenario: "vf",
    };

    if (config.dryRun) {
      log(`[DRY-RUN] Step 5: POST ${config.agentUrl}/codeblue/start ${JSON.stringify(codeBluePayload)}`);
      log(`[DRY-RUN] Step 5: Consensus Card would display: Shock 200 J biphasic (or manufacturer dose)`);
      results.push({
        step: s.step,
        name: s.name,
        outcome: "dry-run",
        auditId: "(dry-run)",
        seconds: 0.0,
      });
    } else {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.agentAdminKey) headers["x-admin-key"] = config.agentAdminKey;

        const startRes = await config.fetchFn(`${config.agentUrl.replace(/\/+$/, "")}/codeblue/start`, {
          method: "POST",
          headers,
          body: JSON.stringify(codeBluePayload),
        });

        let card: any = null;
        let sessionId = "";
        if (startRes.ok) {
          const body = (await startRes.json()) as any;
          card = body.card;
          sessionId = body.session?.id || "";
          log(`Step 5: Code Blue Resuscitation session started (id: ${sessionId})`);
          if (card) {
            console.log("\n" + "=".repeat(60));
            console.log("            CODE BLUE CONSENSUS CARD");
            console.log("=".repeat(60));
            console.log(`  Action:            ${card.action}`);
            console.log(`  Status:            ${card.status}`);
            console.log(`  Confidence:        ${Math.round((card.confidence || 0) * 100)}%`);
            console.log(`  Supporting Agents: ${(card.supporting_agents || []).join(", ")}`);
            if (card.rationale) console.log(`  Rationale:         ${card.rationale}`);
            if (card.warnings && card.warnings.length) {
              console.log(`  Warnings:          ${card.warnings.join("; ")}`);
            }
            console.log("=".repeat(60) + "\n");
          }
        } else {
          const err = await startRes.text().catch(() => "");
          log(`⚠️ Step 5 /codeblue/start returned HTTP ${startRes.status}: ${err.slice(0, 150)}`);
        }

        const audit = await pollAudit(
          config.agentUrl,
          config.agentAdminKey,
          stepStart,
          config.timeoutSec * 1000,
          config.fetchFn
        );
        const finalAuditId = audit.auditId !== "none" ? audit.auditId : sessionId || "cb-session";
        const finalOutcome = audit.outcome !== "timeout" ? audit.outcome : card ? "executed" : "timeout";
        log(`✓ Step ${s.step}: ${s.name} outcome: ${finalOutcome} (audit: ${finalAuditId}) [${audit.durationSec.toFixed(1)}s]`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: finalOutcome,
          auditId: finalAuditId,
          seconds: audit.durationSec,
        });
      } catch (err: any) {
        log(`✗ Step ${s.step}: ${s.name} error: ${err.message}`);
        results.push({
          step: s.step,
          name: s.name,
          outcome: "failed",
          auditId: "none",
          seconds: 0.1,
          details: err.message,
        });
      }
    }
  }

  // Print summary table
  const table = formatSummaryTable(results);
  console.log(table);

  return {
    patientId: config.patientId,
    dryRun: config.dryRun,
    results,
    success: results.every((r) => r.outcome === "executed" || r.outcome === "dry-run" || r.outcome === "review"),
  };
}

/**
 * Parse CLI arguments.
 */
export function parseArgs(argv: string[]): Partial<DemoConfig> {
  const options: Partial<DemoConfig> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--only" && i + 1 < argv.length) {
      options.onlyStep = argv[++i];
    } else if (arg.startsWith("--only=")) {
      options.onlyStep = arg.slice(7);
    } else if (arg === "--patient" && i + 1 < argv.length) {
      options.patientId = argv[++i];
    } else if (arg.startsWith("--patient=")) {
      options.patientId = arg.slice(10);
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      options.timeoutSec = Number(argv[++i]);
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutSec = Number(arg.slice(10));
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
MediCluster Agent-Core Demo Runner

Usage:
  npm run demo [-- [options]]
  node --experimental-strip-types scripts/demo.ts [options]

Options:
  --only <step>       Run only a single step (1..5 or imaging, radar, ecg, dispatch, codeblue)
  --dry-run           Print all synthetic requests without making network calls
  --patient <id>      Specify demo patient ID (must start with DEMO-, default: DEMO-P001)
  --timeout <sec>     Audit poll timeout in seconds per step (default: 90)
  --help, -h          Show this help message

Environment Variables:
  BACKEND_URL         MediCluster backend URL (default: http://localhost:5000)
  DISPATCH_URL        Ambulance dispatch API URL (default: http://localhost:3001)
  AGENT_URL           Agent-Core HTTP URL (default: http://localhost:8100)
  AGENT_ADMIN_KEY     Admin API key for Agent-Core (x-admin-key)
  DEMO_STAFF_EMAIL    Clinician email for demo login
  DEMO_STAFF_PASSWORD Clinician password for demo login
`);
      process.exit(0);
    }
  }

  return options;
}

/**
 * Default CLI entry point.
 */
export async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  const config: DemoConfig = {
    backendUrl: process.env.BACKEND_URL || "http://localhost:5000",
    dispatchUrl: process.env.DISPATCH_URL || "http://localhost:3001",
    agentUrl: process.env.AGENT_URL || "http://localhost:8100",
    agentAdminKey: process.env.AGENT_ADMIN_KEY || "",
    staffEmail: process.env.DEMO_STAFF_EMAIL,
    staffPassword: process.env.DEMO_STAFF_PASSWORD,
    patientId: parsed.patientId || "DEMO-P001",
    dryRun: parsed.dryRun ?? false,
    onlyStep: parsed.onlyStep,
    timeoutSec: parsed.timeoutSec ?? 90,
    fetchFn: globalThis.fetch,
  };

  try {
    const result = await runDemo(config);
    if (!result.success && !result.dryRun) {
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`\n[DEMO ERROR] ${err.message}\n`);
    process.exit(1);
  }
}

// Auto-run when executed directly via node
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("demo.ts") || process.argv[1].endsWith("demo.js"));

if (isDirectRun) {
  void main();
}
