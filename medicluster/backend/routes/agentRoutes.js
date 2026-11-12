const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");

const getAgentCoreUrl = () => (process.env.AGENT_CORE_URL || "http://localhost:8100").replace(/\/+$/, "");
const getAdminKey = () => process.env.AGENT_ADMIN_KEY || "";

function sanitize(val, key) {
  if (!key || typeof key !== "string" || key.trim() === "") return val;
  if (typeof val === "string") {
    return val.replaceAll(key, "[REDACTED]");
  }
  if (Array.isArray(val)) {
    return val.map(item => sanitize(item, key));
  }
  if (val && typeof val === "object") {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      if (k.toLowerCase().includes("admin_key") || k.toLowerCase().includes("x-admin-key")) {
        continue;
      }
      res[k] = sanitize(v, key);
    }
    return res;
  }
  return val;
}

// GET /api/agent/health -> AGENT_CORE_URL/health
router.get("/health", requireAuth, requireRole(["admin", "doctor"]), async (_req, res) => {
  const url = `${getAgentCoreUrl()}/health`;
  const adminKey = getAdminKey();
  try {
    const headers = { Accept: "application/json" };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const response = await fetch(url, { method: "GET", headers });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const sanitized = sanitize(data, adminKey);
    return res.status(response.status).json(sanitized);
  } catch (_err) {
    return res.status(503).json({ error: "Agent core service unavailable" });
  }
});

// GET /api/agent/audit -> AGENT_CORE_URL/audit
router.get("/audit", requireAuth, requireRole(["admin", "doctor"]), async (req, res) => {
  const url = new URL(`${getAgentCoreUrl()}/audit`);
  for (const [key, val] of Object.entries(req.query)) {
    if (val !== undefined) url.searchParams.set(key, String(val));
  }
  const adminKey = getAdminKey();
  try {
    const headers = { Accept: "application/json" };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const response = await fetch(url.toString(), { method: "GET", headers });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const sanitized = sanitize(data, adminKey);
    return res.status(response.status).json(sanitized);
  } catch (_err) {
    return res.status(503).json({ error: "Agent core service unavailable" });
  }
});

// GET /api/agent/audit/:id -> AGENT_CORE_URL/audit/:id
router.get("/audit/:id", requireAuth, requireRole(["admin", "doctor"]), async (req, res) => {
  const url = `${getAgentCoreUrl()}/audit/${encodeURIComponent(req.params.id)}`;
  const adminKey = getAdminKey();
  try {
    const headers = { Accept: "application/json" };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const response = await fetch(url, { method: "GET", headers });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const sanitized = sanitize(data, adminKey);
    return res.status(response.status).json(sanitized);
  } catch (_err) {
    return res.status(503).json({ error: "Agent core service unavailable" });
  }
});

// POST /api/agent/codeblue/start -> AGENT_CORE_URL/codeblue/start
router.post("/codeblue/start", requireAuth, requireRole(["admin", "doctor"]), async (req, res) => {
  const url = `${getAgentCoreUrl()}/codeblue/start`;
  const adminKey = getAdminKey();
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body || {}),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const sanitized = sanitize(data, adminKey);
    return res.status(response.status).json(sanitized);
  } catch (_err) {
    return res.status(503).json({ error: "Agent core service unavailable" });
  }
});

// POST /api/agent/control/:action(stop|start) -> AGENT_CORE_URL/control/:action
router.post("/control/:action", requireAuth, requireRole(["admin"]), async (req, res) => {
  const { action } = req.params;
  if (action !== "stop" && action !== "start") {
    return res.status(400).json({ error: "Invalid control action. Expected 'stop' or 'start'." });
  }
  const url = `${getAgentCoreUrl()}/control/${action}`;
  const adminKey = getAdminKey();
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body || {}),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const sanitized = sanitize(data, adminKey);
    return res.status(response.status).json(sanitized);
  } catch (_err) {
    return res.status(503).json({ error: "Agent core service unavailable" });
  }
});

module.exports = router;
