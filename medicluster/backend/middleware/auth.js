/**
 * backend/middleware/auth.js
 * JWT session tokens for clinician accounts.
 */

const jwt = require("jsonwebtoken");
const User = require('../models/User');
const { staffEmails, staffAllowed } = require('../services/staffAccess');

const TOKEN_TTL = "12h";

function secret() {
  const value = process.env.JWT_SECRET;
  // Fail closed: never sign or accept tokens with a missing or trivially short secret.
  if (!value || value.length < 32) {
    const err = new Error("Authentication is not configured (JWT_SECRET must be at least 32 characters)");
    err.status = 503;
    throw err;
  }
  return value;
}

const PATIENT_TOKEN_TTL = "30d";

function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, secret(), { expiresIn: TOKEN_TTL });
}

// Patient sessions (mobile app) carry kind "patient" and only grant access to that patient's own data.
function signPatientToken(patientId) {
  return jwt.sign({ sub: patientId, kind: "patient" }, secret(), { expiresIn: PATIENT_TOKEN_TTL });
}

const AGENT_SUBJECT = "agent-core";
const FILE_ID = "[a-zA-Z0-9_-]{1,128}";

// The only routes the autonomous agent-core service may call (matched on method + full path).
const AGENT_ROUTES = [
  { method: "GET", pattern: /^\/api\/media\/models$/ },
  { method: "POST", pattern: new RegExp(`^/api/media/analyze/${FILE_ID}$`) },
  { method: "POST", pattern: new RegExp(`^/api/media/review/${FILE_ID}$`) },
  { method: "POST", pattern: /^\/api\/alerts\/agent$/ },
  { method: "POST", pattern: /^\/api\/intelligence\/rhythm\/classify$/ },
];

function agentSecret() {
  const value = process.env.AGENT_JWT_SECRET;
  return value && value.length >= 32 ? value : null;
}

function signAgentToken() {
  const key = agentSecret();
  if (!key) {
    const err = new Error("Agent authentication is not configured (AGENT_JWT_SECRET must be at least 32 characters)");
    err.status = 503;
    throw err;
  }
  return jwt.sign({ sub: AGENT_SUBJECT, kind: "agent" }, key, { expiresIn: TOKEN_TTL });
}

// → { kind: "clinician", userId } | { kind: "patient", patientId } | { kind: "agent" } | null (missing/invalid). Throws if unconfigured.
function readSession(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const key = secret();
  try {
    const p = jwt.verify(token, key);
    // Agent identity only exists under AGENT_JWT_SECRET; never honour it under the user secret.
    if (p.kind === "agent") return null;
    return p.kind === "patient" ? { kind: "patient", patientId: p.sub } : { kind: "clinician", userId: p.sub };
  } catch {
    // fall through to the agent secret
  }
  const agentKey = agentSecret();
  if (!agentKey) return null;
  try {
    const p = jwt.verify(token, agentKey);
    return p.kind === "agent" ? { kind: "agent" } : null;
  } catch {
    return null;
  }
}

// Clinician-only APIs. Patient tokens are rejected.
async function requireAuth(req, res, next) {
  let session;
  try { session = readSession(req); } catch (err) { return next(err); }
  if (!session) return res.status(401).json({ error: "Sign in required" });
  if (session.kind === "agent") {
    const path = req.baseUrl + req.path;
    if (!AGENT_ROUTES.some(r => r.method === req.method && r.pattern.test(path))) {
      return res.status(403).json({ error: "Agent access not permitted for this route" });
    }
    req.userId = AGENT_SUBJECT;
    req.agent = true;
    return next();
  }
  if (session.kind !== "clinician") return res.status(403).json({ error: "Clinician sign-in required" });
  try {
    if (!await allowedClinicianSession(session)) return res.status(403).json({ error: "This account isn't enabled for clinician access" });
  } catch (err) { return next(err); }
  req.userId = session.userId;
  return next();
}

// Clinicians, or the signed-in patient. Use canAccessPatient(req, id) to check a specific record.
async function requirePatientOrClinician(req, res, next) {
  let session;
  try { session = readSession(req); } catch (err) { return next(err); }
  if (!session) return res.status(401).json({ error: "Sign in required" });
  try {
    if (session.kind === 'clinician' && !await allowedClinicianSession(session)) {
      return res.status(403).json({ error: "This account isn't enabled for clinician access" });
    }
  } catch (err) { return next(err); }
  if (session.kind === "agent") return res.status(403).json({ error: "Agent access not permitted for this route" });
  req.session = session;
  return next();
}

async function allowedClinicianSession(session) {
  if (staffEmails().length === 0) return true;
  const user = await User.findById(session.userId).select('email');
  return Boolean(user && staffAllowed(user.email));
}

const canAccessPatient = (req, patientId) =>
  req.session?.kind === "clinician" || (req.session?.kind === "patient" && req.session.patientId === patientId);

module.exports = { signToken, signPatientToken, signAgentToken, AGENT_ROUTES, requireAuth, requirePatientOrClinician, canAccessPatient };
