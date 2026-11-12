import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/api/server.js";

const KEY = "admin-key-123";
const analyzedDoc = { _id: "m1", updatedAt: "2026-01-01T00:00:10.000Z", analysis: { analyzedAt: "2026-01-01T00:00:09.000Z" } };

let server: http.Server;
let base: string;
let stopped: boolean;
let queue: string[];
let handled: any[];
let docs: any[];

beforeEach(async () => {
  stopped = false;
  queue = [];
  handled = [];
  docs = [analyzedDoc, { _id: "m2" }];
  const state = {
    isStopped: async () => stopped,
    setStopped: async (b: boolean) => {
      stopped = b;
    },
  } as any;
  const loop = {
    handle: vi.fn(async (e: any) => {
      handled.push(e);
      return "executed";
    }),
    retryPending: vi.fn(async () => {
      const n = queue.length;
      for (const id of queue) handled.push({ id });
      queue = [];
      return n;
    }),
  } as any;
  const audit = { list: vi.fn(async () => [{ _id: "a1" }]) } as any;
  const health = { isUp: (n: string) => n !== "ml" } as any;
  const store = {
    find: vi.fn(async (_c: string, f: any) => docs.filter((d) => d._id === f._id)),
  } as any;
  server = createServer({ audit, state, loop, health, store, adminKey: KEY });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (server as any).__loop = loop;
  (server as any).__audit = audit;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

const admin = { "x-admin-key": KEY };
const post = (path: string, body?: string, headers: Record<string, string> = admin) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("api", () => {
  it("console is public html", async () => {
    const res = await fetch(`${base}/console`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("CliniQ");
  });

  it("health is public", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      stopped: false,
      services: { backend: true, ml: false, intelligence: true },
    });
  });

  it("audit requires admin key", async () => {
    expect((await fetch(`${base}/audit`)).status).toBe(401);
    expect((await fetch(`${base}/audit`, { headers: { "x-admin-key": "wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/audit`, { headers: { "x-admin-key": KEY + "x" } })).status).toBe(401);
    const res = await fetch(`${base}/audit?since=2026-01-01&limit=5`, { headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ _id: "a1" }]);
    expect((server as any).__audit.list).toHaveBeenCalledWith("2026-01-01", 5);
  });

  it("bad limit 400", async () => {
    for (const l of ["0", "201", "abc", "1.5", ""]) {
      expect((await fetch(`${base}/audit?limit=${l}`, { headers: admin })).status).toBe(400);
    }
  });

  it("stop then start drains queue", async () => {
    expect((await post("/control/stop", undefined, {})).status).toBe(401);
    let res = await post("/control/stop");
    expect(await res.json()).toEqual({ stopped: true });
    expect(stopped).toBe(true);
    queue = ["e1"];
    res = await post("/control/start");
    expect(await res.json()).toEqual({ stopped: false });
    expect(stopped).toBe(false);
    expect(handled).toEqual([{ id: "e1" }]);
    await post("/control/start");
    expect(handled).toHaveLength(1);
  });

  it("unsupported command 400", async () => {
    for (const body of [`{"type":"delete","mediaId":"m1"}`, `{"type":"reprocess"}`, `{"type":"reprocess","mediaId":"../x"}`, `[]`]) {
      const res = await post("/command", body);
      expect(res.status).toBe(400);
    }
    const res = await post("/command", `{"type":"nope"}`);
    expect(await res.json()).toEqual({ error: "Unsupported command" });
  });

  it("invalid json 400, oversized body rejected", async () => {
    expect((await post("/command", "{not json")).status).toBe(400);
    const big = JSON.stringify({ type: "reprocess", mediaId: "m1", pad: "x".repeat(20000) });
    const res = await post("/command", big).catch(() => null);
    if (res) expect(res.status).toBe(413);
    expect(handled).toHaveLength(0);
  });

  it("command requires admin key", async () => {
    expect((await post("/command", `{"type":"reprocess","mediaId":"m1"}`, {})).status).toBe(401);
  });

  it("reprocess runs loop.handle on scan.analyzed", async () => {
    const res = await post("/command", `{"type":"reprocess","mediaId":"m1"}`);
    expect(res.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "scan.analyzed", mediaId: "m1" });
    expect(await res.json()).toEqual({ outcome: "executed" });
  });

  it("reprocess 404 and 400 for unanalysed", async () => {
    let res = await post("/command", `{"type":"reprocess","mediaId":"nope"}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Media not found" });
    res = await post("/command", `{"type":"reprocess","mediaId":"m2"}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Media not analysed" });
  });

  it("unknown route 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("control/start resilience", () => {
  it("returns 200 stopped:false when retryPending throws", async () => {
    (server as any).__loop.retryPending.mockRejectedValueOnce(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/control/start");
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false });
  });
});
