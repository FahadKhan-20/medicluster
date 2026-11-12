import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Audit } from "../audit/audit.js";
import type { AgentState } from "../control/state.js";
import type { AgentLoop } from "../agent/loop.js";
import type { McStore } from "../store/mc.js";
import type { BuilderService } from "../builder/builder.js";
import { rowToEvent } from "../events/events.js";
import { getConsoleHtml } from "../console/index.js";
import type { CodeBlueEngine } from "../codeblue/session.js";
import { handleCodeBlueRoute } from "../codeblue/routes.js";

export interface ServerDeps {
  audit: Pick<Audit, "list">;
  state: Pick<AgentState, "isStopped" | "setStopped">;
  loop: Pick<AgentLoop, "handle" | "retryPending">;
  health: { isUp(name: string): boolean };
  store: Pick<McStore, "find">;
  adminKey: string;
  builder?: Pick<BuilderService, "handleTask">;
  codeblue?: CodeBlueEngine;
}

const MAX_BODY = 16 * 1024;
const MEDIA_ID = /^[a-zA-Z0-9_-]{1,128}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
  res.end(html);
}

function keyMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
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

export function createServer(deps: ServerDeps): http.Server {
  const { audit, state, loop, health, store, adminKey, builder } = deps;

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      return send(res, 200, {
        status: "ok",
        stopped: await state.isStopped(),
        services: {
          backend: health.isUp("backend"),
          ml: health.isUp("ml"),
          intelligence: health.isUp("intelligence"),
        },
      });
    }

    if (method === "GET" && (path === "/console" || path === "/console/" || path === "/console/index.html")) {
      return sendHtml(res, 200, getConsoleHtml());
    if (deps.codeblue && (await handleCodeBlueRoute(req, res, deps.codeblue, adminKey, keyMatches))) {
      return;
    }

    const known =
      (method === "GET" && path === "/audit") ||
      (method === "POST" && ["/control/stop", "/control/start", "/command", "/builder/task"].includes(path));
    if (!known) return send(res, 404, { error: "Not found" });
    if (!keyMatches(req.headers["x-admin-key"], adminKey)) return send(res, 401, { error: "Unauthorized" });

    if (path === "/audit") {
      const rawLimit = url.searchParams.get("limit");
      let limit = 50;
      if (rawLimit !== null) {
        limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
        if (!(limit >= 1 && limit <= 200)) return send(res, 400, { error: "limit must be an integer from 1 to 200" });
      }
      const since = url.searchParams.get("since") || undefined;
      return send(res, 200, await audit.list(since, limit));
    }

    if (path === "/control/stop") {
      await state.setStopped(true);
      return send(res, 200, { stopped: true });
    }

    if (path === "/control/start") {
      await state.setStopped(false);
      try {
        await loop.retryPending();
      } catch (err) {
        console.error("[api] retryPending after start failed", err);
      }
      return send(res, 200, { stopped: false });
    }

    if (path === "/builder/task") {
      const body = await readJson(req);
      const task = body as { title?: unknown; description?: unknown } | null;
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        return send(res, 400, { error: "Invalid task body" });
      }
      if (typeof task.title !== "string" || !task.title.trim()) {
        return send(res, 400, { error: "title is required" });
      }
      if (typeof task.description !== "string" || !task.description.trim()) {
        return send(res, 400, { error: "description is required" });
      }
      if (!builder) {
        return send(res, 503, { error: "Builder service not configured" });
      }
      try {
        const result = await builder.handleTask({
          title: task.title.trim(),
          description: task.description.trim(),
        });
        return send(res, 200, result);
      } catch (err: any) {
        if (err?.status === 409 || err?.name === "BuilderConcurrencyError") {
          return send(res, 409, { error: err.message });
        }
        throw err;
      }
    }

    // POST /command
    const body = await readJson(req);
    const cmd = body as { type?: unknown; mediaId?: unknown } | null;
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd) || cmd.type !== "reprocess") {
      return send(res, 400, { error: "Unsupported command" });
    }
    if (typeof cmd.mediaId !== "string" || !MEDIA_ID.test(cmd.mediaId)) {
      return send(res, 400, { error: "Invalid mediaId" });
    }
    const [doc] = await store.find("patientmedias", { _id: cmd.mediaId }, undefined, 1);
    if (!doc) return send(res, 404, { error: "Media not found" });
    const event = doc?.analysis?.analyzedAt ? rowToEvent({ collection: "patientmedias", data: doc }, {}) : null;
    if (!event) return send(res, 400, { error: "Media not analysed" });
    return send(res, 200, { outcome: await loop.handle(event) });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("connection", "close");
        return send(res, err.status, { error: err.message });
      }
      console.error("[api]", err);
      send(res, 500, { error: "Internal error" });
    });
  });
}
