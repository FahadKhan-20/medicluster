/**
 * Render & sanitization helpers for the Agent Auditor Console and Decision Replay.
 * Guarantees that:
 * 1. All strings are safely HTML-escaped to prevent any XSS attacks.
 * 2. Large strings in tool args/results/state are truncated to 500 characters.
 */

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncateString(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + `… [truncated to ${maxLength} chars]`;
}

/** Recursively truncate string properties in objects/arrays to prevent massive payloads. */
export function truncateDeep(obj: unknown, maxLength = 500): unknown {
  if (typeof obj === "string") {
    return truncateString(obj, maxLength);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => truncateDeep(item, maxLength));
  }
  if (obj !== null && typeof obj === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = truncateDeep(v, maxLength);
    }
    return res;
  }
  return obj;
}

export function formatJsonSafe(value: unknown, maxLength = 500): string {
  const truncated = truncateDeep(value, maxLength);
  return escapeHtml(JSON.stringify(truncated, null, 2));
}

export interface ReplayStepData {
  step: number;
  name: string;
  title: string;
  html: string;
}

export const REPLAY_STEP_NAMES = [
  "Event",
  "Gemini State",
  "Jev Decision",
  "Gate Result",
  "Tool Calls",
  "Outcome",
] as const;

/**
 * Render a single step (1-6) of the decision replay for a given audit record.
 * All rendered data is guaranteed to be strictly escaped and truncated.
 */
export function renderReplayStep(stepIndex: number, audit: any): string {
  if (!audit) {
    return `<div class="replay-empty">No audit data available.</div>`;
  }

  const steps: any[] = Array.isArray(audit.steps) ? audit.steps : [];

  switch (stepIndex) {
    case 1: {
      // 1. Event (type, ids, time)
      const ev = audit.event || {};
      const evType = ev.type || ev.kind || "unknown.event";
      const mediaId = ev.mediaId || ev.data?._id || ev.doc?._id || "—";
      const patientId = ev.patientId || ev.doc?.patient_id || ev.doc?.patientId || "—";
      const eventId = ev.id || audit._id || "—";
      const startedAt = audit.startedAt ? new Date(audit.startedAt).toLocaleString() : "—";
      const eventTime = ev.at ? new Date(ev.at).toLocaleString() : startedAt;

      return `
        <div class="replay-step-content" data-step="1">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 1 of 6</span>
            <h3 class="replay-step-title">Event Ingestion</h3>
            <span class="tag-badge tag-pass">${escapeHtml(evType)}</span>
          </div>

          <div class="replay-meta-grid">
            <div class="replay-meta-card">
              <span class="replay-meta-label">Event Type</span>
              <span class="replay-meta-val">${escapeHtml(evType)}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Media ID</span>
              <span class="replay-meta-val font-mono">${escapeHtml(truncateString(mediaId, 500))}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Patient ID</span>
              <span class="replay-meta-val font-mono">${escapeHtml(truncateString(patientId, 500))}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Event ID</span>
              <span class="replay-meta-val font-mono">${escapeHtml(truncateString(eventId, 500))}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Timestamp</span>
              <span class="replay-meta-val">${escapeHtml(eventTime)}</span>
            </div>
          </div>

          <div class="replay-raw-box">
            <div class="replay-raw-label">Raw Event Payload</div>
            <pre class="code-viewer">${formatJsonSafe(ev, 500)}</pre>
          </div>
        </div>
      `;
    }

    case 2: {
      // 2. State built by Gemini (facts)
      const stateStep = steps.find((s) => s.kind === "state");
      const facts = stateStep?.data || {};
      const hasFacts = Object.keys(facts).length > 0;

      return `
        <div class="replay-step-content" data-step="2">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 2 of 6</span>
            <h3 class="replay-step-title">State Built by Gemini (Facts Only)</h3>
            <span class="tag-badge ${hasFacts ? "tag-pass" : "tag-escalate"}">${hasFacts ? "Facts Ready" : "No State Step"}</span>
          </div>

          ${
            hasFacts
              ? `
            <div class="replay-meta-grid">
              ${Object.entries(facts)
                .slice(0, 6)
                .map(([k, v]) => {
                  const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
                  return `
                    <div class="replay-meta-card">
                      <span class="replay-meta-label">${escapeHtml(k)}</span>
                      <span class="replay-meta-val font-mono">${escapeHtml(truncateString(valStr, 500))}</span>
                    </div>
                  `;
                })
                .join("")}
            </div>
          `
              : `<div class="replay-notice">No dedicated Gemini state extraction step recorded for this audit entry.</div>`
          }

          <div class="replay-raw-box">
            <div class="replay-raw-label">State Object Details</div>
            <pre class="code-viewer">${formatJsonSafe(facts, 500)}</pre>
          </div>
        </div>
      `;
    }

    case 3: {
      // 3. Jev questions + probabilities (bar per option, chosen highlighted, act_now noul, fallback flagged in red with error reason)
      const jevStep = steps.find((s) => s.kind === "jev");
      const jevData = jevStep?.data || {};
      const ans = jevData.answers || {};
      const isFallback = Boolean(jevData.fallback || jevData.error);
      const errorMsg = jevData.error ? String(jevData.error) : isFallback ? "Jev decision fallback active" : "";

      let questionsHtml = "";

      // Render each question
      for (const [qName, qAns] of Object.entries(ans)) {
        if (!qAns || typeof qAns !== "object") continue;
        const answer = qAns as any;
        const qTitle = qName === "action" ? "Action Decision" : qName === "urgency" ? "Urgency Scoring" : escapeHtml(qName);
        const choice = answer.choice !== undefined ? String(answer.choice) : answer.score !== undefined ? String(answer.score) : "—";
        const probs = answer.probabilities || {};

        let barsHtml = "";
        const probEntries = Object.entries(probs);
        if (probEntries.length > 0) {
          barsHtml = probEntries
            .map(([opt, p]) => {
              const numP = Number(p) || 0;
              const pct = Math.round(numP * 100);
              const isChosen = opt === choice;
              return `
                <div class="prob-row ${isChosen ? "prob-row-chosen" : ""}">
                  <div class="prob-labels">
                    <span class="prob-option-name ${isChosen ? "font-bold text-highlight" : ""}">${escapeHtml(opt)}${isChosen ? ' <span class="chosen-badge">CHOSEN</span>' : ""}</span>
                    <span class="prob-option-pct font-mono">${pct}%</span>
                  </div>
                  <div class="prob-track">
                    <div class="prob-fill ${isChosen ? "chosen" : ""}" style="width:${pct}%;"></div>
                  </div>
                </div>
              `;
            })
            .join("");
        }

        // Handle act_now / noul
        let noulHtml = "";
        if (answer.noul !== undefined || qName === "act_now") {
          const noulVal = Number(answer.noul ?? 0);
          const noulPct = Math.round(noulVal * 100);
          const safe = noulVal >= 0.9;
          noulHtml = `
            <div class="prob-row">
              <div class="prob-labels">
                <span>Noul Safety Score (&ge; 0.90 required)</span>
                <span class="font-mono ${safe ? "text-pass" : "text-block"}">${noulVal.toFixed(3)} (${noulPct}%)</span>
              </div>
              <div class="prob-track">
                <div class="prob-fill ${safe ? "chosen" : "blocked"}" style="width:${noulPct}%;"></div>
              </div>
            </div>
          `;
        }

        questionsHtml += `
          <div class="jev-card">
            <div class="jev-card-header">
              <span class="jev-card-title">${escapeHtml(qTitle)}</span>
              <span class="tag-badge tag-pass">${escapeHtml(truncateString(choice, 500))}</span>
            </div>
            ${barsHtml}
            ${noulHtml}
          </div>
        `;
      }

      return `
        <div class="replay-step-content" data-step="3">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 3 of 6</span>
            <h3 class="replay-step-title">Jev Decision & Probabilities</h3>
            <span class="tag-badge ${isFallback ? "tag-block" : "tag-pass"}">${isFallback ? "Fallback Triggered" : "Jev Evaluated"}</span>
          </div>

          ${
            isFallback
              ? `
            <div class="replay-fallback-banner">
              <div class="fallback-icon">⚠️</div>
              <div class="fallback-text">
                <strong>Fallback Triggered</strong>
                <p>${escapeHtml(truncateString(errorMsg || "Jev fallback answer used due to provider error.", 500))}</p>
              </div>
            </div>
          `
              : ""
          }

          <div class="jev-grid">
            ${questionsHtml || '<div class="replay-notice">No Jev answers recorded in this step.</div>'}
          </div>

          <div class="replay-raw-box">
            <div class="replay-raw-label">Jev Decision Data</div>
            <pre class="code-viewer">${formatJsonSafe(jevData, 500)}</pre>
          </div>
        </div>
      `;
    }

    case 4: {
      // 4. Gate result (level, threshold, verdict, reason)
      const gateStep = steps.find((s) => s.kind === "gate" || s.kind === "review_gate");
      const gateData = gateStep?.data || {};
      const verdict = String(gateData.verdict || "unknown");
      const reason = gateData.reason ? String(gateData.reason) : "—";
      const level = gateData.level || gateData.groupLevel || "auto";
      const threshold = gateData.threshold !== undefined ? String(gateData.threshold) : "0.90";
      const key = gateData.key ? String(gateData.key) : "—";

      let tagClass = "tag-pass";
      if (verdict === "blocked" || verdict === "deny") tagClass = "tag-block";
      else if (verdict === "review" || verdict === "suggest") tagClass = "tag-escalate";

      return `
        <div class="replay-step-content" data-step="4">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 4 of 6</span>
            <h3 class="replay-step-title">Safety Gate Verdict</h3>
            <span class="tag-badge ${tagClass}">${escapeHtml(verdict)}</span>
          </div>

          <div class="replay-meta-grid">
            <div class="replay-meta-card">
              <span class="replay-meta-label">Verdict</span>
              <span class="replay-meta-val font-bold ${verdict === "execute" || verdict === "allow" ? "text-pass" : verdict === "blocked" ? "text-block" : "text-escalate"}">${escapeHtml(verdict)}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Reason</span>
              <span class="replay-meta-val font-mono">${escapeHtml(truncateString(reason, 500))}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Policy Level</span>
              <span class="replay-meta-val">${escapeHtml(level)}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Threshold</span>
              <span class="replay-meta-val font-mono">&ge; ${escapeHtml(threshold)}</span>
            </div>
            <div class="replay-meta-card" style="grid-column: 1 / -1;">
              <span class="replay-meta-label">Idempotency Key</span>
              <span class="replay-meta-val font-mono text-dim">${escapeHtml(truncateString(key, 500))}</span>
            </div>
          </div>

          <div class="replay-raw-box">
            <div class="replay-raw-label">Gate Verification Data</div>
            <pre class="code-viewer">${formatJsonSafe(gateData, 500)}</pre>
          </div>
        </div>
      `;
    }

    case 5: {
      // 5. Tool calls (name, args, status, duration)
      const toolSteps = steps.filter((s) => s.kind === "tool");
      const argsStep = steps.find((s) => s.kind === "args");

      let toolsHtml = "";
      if (toolSteps.length > 0) {
        toolsHtml = toolSteps
          .map((t, idx) => {
            const data = t.data || {};
            const toolName = data.tool || data.name || "Tool Execution";
            const result = data.result || {};
            const status = result.status !== undefined ? `HTTP ${result.status}` : result.ok ? "Success (200)" : "Pending";
            const duration = result.duration !== undefined ? `${result.duration}ms` : "—";
            const args = data.args || (argsStep?.data?.arguments ?? {});

            return `
              <div class="tool-call-card">
                <div class="tool-call-header">
                  <span class="tool-name-badge">Tool #${idx + 1}: ${escapeHtml(truncateString(toolName, 500))}</span>
                  <span class="tag-badge ${result.ok !== false ? "tag-pass" : "tag-block"}">${escapeHtml(status)}</span>
                </div>
                <div class="replay-meta-grid" style="margin-top:10px;">
                  <div class="replay-meta-card">
                    <span class="replay-meta-label">Status</span>
                    <span class="replay-meta-val">${escapeHtml(status)}</span>
                  </div>
                  <div class="replay-meta-card">
                    <span class="replay-meta-label">Duration</span>
                    <span class="replay-meta-val font-mono">${escapeHtml(duration)}</span>
                  </div>
                </div>
                <div class="replay-raw-box" style="margin-top:10px;">
                  <div class="replay-raw-label">Arguments</div>
                  <pre class="code-viewer">${formatJsonSafe(args, 500)}</pre>
                </div>
                ${
                  result.error
                    ? `
                  <div class="replay-fallback-banner" style="margin-top:10px;">
                    <div class="fallback-icon">⚠️</div>
                    <div class="fallback-text">
                      <strong>Tool Error</strong>
                      <p>${escapeHtml(truncateString(String(result.error), 500))}</p>
                    </div>
                  </div>
                `
                    : ""
                }
              </div>
            `;
          })
          .join("");
      } else {
        toolsHtml = `
          <div class="replay-notice">
            No external tool execution steps recorded. (Decision may have been skipped, blocked, or in review).
          </div>
        `;
      }

      return `
        <div class="replay-step-content" data-step="5">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 5 of 6</span>
            <h3 class="replay-step-title">Tool Execution & Arguments</h3>
            <span class="tag-badge ${toolSteps.length > 0 ? "tag-pass" : "tag-escalate"}">${toolSteps.length} Tool Calls</span>
          </div>
          ${toolsHtml}
        </div>
      `;
    }

    case 6: {
      // 6. Outcome
      const outcome = String(audit.outcome || "unknown").toLowerCase();
      const reason = audit.reason ? String(audit.reason) : "—";
      const started = audit.startedAt ? new Date(audit.startedAt) : null;
      const finished = audit.finishedAt ? new Date(audit.finishedAt) : null;
      const durationMs = started && finished ? finished.getTime() - started.getTime() : null;
      const durationStr = durationMs !== null ? `${durationMs}ms` : "—";

      let score = 90;
      let decTitle = "Executed";
      let decCol = "var(--col-pass)";
      if (outcome === "executed") {
        score = 98;
        decTitle = "Passed & Executed";
        decCol = "var(--col-pass)";
      } else if (outcome === "review" || outcome === "pending") {
        score = 65;
        decTitle = "Needs Clinical Review";
        decCol = "var(--col-escalate)";
      } else if (outcome === "blocked" || outcome === "failed") {
        score = 0;
        decTitle = "Action Blocked by Gate";
        decCol = "var(--col-block)";
      } else if (outcome === "skipped") {
        score = 50;
        decTitle = "Execution Skipped";
        decCol = "var(--text-muted)";
      }

      return `
        <div class="replay-step-content" data-step="6">
          <div class="replay-step-header">
            <span class="replay-step-num">Step 6 of 6</span>
            <h3 class="replay-step-title">Final Decision Outcome</h3>
            <span class="tag-badge ${outcome === "executed" ? "tag-pass" : outcome === "blocked" ? "tag-block" : "tag-escalate"}">${escapeHtml(outcome)}</span>
          </div>

          <div class="thread-header-score" style="margin-top:14px; background:var(--bg-card); border-radius:12px; padding:16px;">
            <div class="score-circle-lg">
              <svg viewBox="0 0 36 36" width="56" height="56">
                <circle cx="18" cy="18" r="15" fill="none" stroke="#27272b" stroke-width="3.5"></circle>
                <circle cx="18" cy="18" r="15" fill="none" stroke="${decCol}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="94.25" stroke-dashoffset="${94.25 - (94.25 * score) / 100}" transform="rotate(-90 18 18)"></circle>
              </svg>
              <b style="color:${decCol}">${score}</b>
            </div>
            <div>
              <div class="thread-header-title">${escapeHtml(decTitle)}</div>
              <div class="thread-header-sub">Final audit status: <strong>${escapeHtml(outcome)}</strong> • Reason: <code>${escapeHtml(truncateString(reason, 500))}</code></div>
            </div>
          </div>

          <div class="replay-meta-grid" style="margin-top:14px;">
            <div class="replay-meta-card">
              <span class="replay-meta-label">Final Outcome</span>
              <span class="replay-meta-val font-bold ${outcome === "executed" ? "text-pass" : outcome === "blocked" ? "text-block" : "text-escalate"}">${escapeHtml(outcome)}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Termination Reason</span>
              <span class="replay-meta-val font-mono">${escapeHtml(truncateString(reason, 500))}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Total Execution Time</span>
              <span class="replay-meta-val font-mono">${escapeHtml(durationStr)}</span>
            </div>
            <div class="replay-meta-card">
              <span class="replay-meta-label">Total Recorded Steps</span>
              <span class="replay-meta-val font-mono">${steps.length} steps</span>
            </div>
          </div>
        </div>
      `;
    }

    default:
      return `<div class="replay-notice">Invalid step index: ${stepIndex}</div>`;
  }
}
