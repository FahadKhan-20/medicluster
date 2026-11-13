/**
 * Code Blue HTTP API and static dashboard routes.
 */

import type http from "node:http";
import type { CodeBlueEngine } from "./session.js";
import { renderCodeBluePage } from "./ui.js";

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export async function handleCodeBlueRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: CodeBlueEngine,
  adminKey: string,
  keyMatches: (given: string | string[] | undefined, expected: string) => boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const path = url.pathname;

  // 1. Static Trauma-Bay Page: GET /codeblue
  if (method === "GET" && path === "/codeblue") {
    // Public shell only: the page reads the admin key from the console session, never from the server.
    sendHtml(res, 200, renderCodeBluePage());
    return true;
  }

  // Check if route belongs to codeblue API
  const isCodeBlueApi =
    (method === "POST" && path === "/codeblue/start") ||
    (method === "GET" && /^\/codeblue\/[a-zA-Z0-9_-]+\/card$/.test(path)) ||
    (method === "POST" && /^\/codeblue\/[a-zA-Z0-9_-]+\/ack$/.test(path)) ||
    (method === "POST" && /^\/codeblue\/[a-zA-Z0-9_-]+\/stop$/.test(path));

  if (!isCodeBlueApi) return false;

  // Require admin key for API actions
  const reqAdminKey = req.headers["x-admin-key"];
  if (!keyMatches(reqAdminKey, adminKey)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  // 2. POST /codeblue/start
  if (method === "POST" && path === "/codeblue/start") {
    const body = await readJson(req);
    const patientId = typeof body?.patientId === "string" ? body.patientId.trim() : "";
    if (!patientId) {
      sendJson(res, 400, { error: "Missing or invalid patientId" });
      return true;
    }

    const session = await engine.start(patientId, {
      useSimulator: body?.scenario !== false,
      patientRecord: body?.patientRecord,
    });

    const telemetry = session.getLatestTelemetry();
    sendJson(res, 200, {
      session: {
        id: session.id,
        patientId: session.patientId,
        startTimeMs: session.startTimeMs,
      },
      card: session.getLatestCard(),
      telemetry,
    });
    return true;
  }

  // Extract sessionId from /codeblue/:id/...
  const match = /^\/codeblue\/([a-zA-Z0-9_-]+)\/(card|ack|stop)$/.exec(path);
  if (!match) {
    sendJson(res, 404, { error: "Route not found" });
    return true;
  }

  const sessionId = match[1];
  const subRoute = match[2];
  const session = engine.getSession(sessionId);

  if (!session) {
    sendJson(res, 404, { error: `Session ${sessionId} not found` });
    return true;
  }

  // 3. GET /codeblue/:id/card
  if (method === "GET" && subRoute === "card") {
    const telemetry = await engine.poll(sessionId);
    sendJson(res, 200, {
      card: session.getLatestCard(),
      telemetry,
    });
    return true;
  }

  // 4. POST /codeblue/:id/ack
  if (method === "POST" && subRoute === "ack") {
    const body = await readJson(req);
    const action = typeof body?.action === "string" ? body.action : "";
    if (!action) {
      sendJson(res, 400, { error: "Missing action to acknowledge" });
      return true;
    }

    const clinician = typeof body?.clinician === "string" ? body.clinician : "Clinician Confirm";
    const result = await engine.ack(sessionId, action, clinician);
    sendJson(res, 200, {
      acknowledged: true,
      action,
      auditId: result.auditId,
      card: session.getLatestCard(),
    });
    return true;
  }

  // 5. POST /codeblue/:id/stop
  if (method === "POST" && subRoute === "stop") {
    const body = (await readJson(req).catch(() => ({}))) || {};
    const clinician = typeof body?.clinician === "string" ? body.clinician : "Clinician Stop";
    const result = await engine.stop(sessionId, clinician);
    sendJson(res, 200, {
      stopped: true,
      auditId: result.auditId,
    });
    return true;
  }

  return false;
}
