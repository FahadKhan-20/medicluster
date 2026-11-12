import { describe, expect, it, vi } from "vitest";
import { BackendClient } from "../src/tools/backend.js";
import { TOOLS, listModels, toolForAction, validateArgs } from "../src/tools/registry.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mk = (fetch: typeof globalThis.fetch, token = () => "tok") =>
  new BackendClient({ baseUrl: "http://be:3000/", token, fetch, backoffMs: 0 });

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("BackendClient", () => {
  it("sends agent bearer token, re-evaluated on every request", async () => {
    const fetch = vi.fn(async () => json(200, { models: [] }));
    const token = vi.fn().mockReturnValueOnce("t1").mockReturnValueOnce("t2");
    const c = mk(fetch, token);
    const r = await listModels(c);
    await listModels(c);
    expect(r).toEqual({ ok: true, status: 200, data: { models: [] } });
    expect(token).toHaveBeenCalledTimes(2);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("http://be:3000/api/media/models");
    expect(calls[0][1].method).toBe("GET");
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer t1");
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer t2");
  });

  it("5xx retried 3 times then ok:false", async () => {
    const fetch = vi.fn(async () => json(503, { error: "down" }));
    const r = await mk(fetch, () => "secret-token").call("POST", "/api/media/review/f1");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.retryable).toBe(false);
      expect(JSON.stringify(r)).not.toContain("secret-token");
    }
  });

  it("network errors are retried", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(json(200, { a: 1 }));
    const r = await mk(fetch).call("GET", "/x");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ ok: true, status: 200, data: { a: 1 } });
  });

  it("review 400 is failed without retry", async () => {
    const fetch = vi.fn(async () => json(400, { error: "bad" }));
    const r = await tool("imaging.request_review").run({ fileId: "f1" }, mk(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe("tools", () => {
  it("path ids are encoded and validated", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const t = tool("imaging.analyze");
    expect(validateArgs(t, { fileId: "../x" }).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(validateArgs(t, { fileId: "a_b-1", model_name: "m" })).toEqual([]);
    await t.run({ fileId: "a b/c" }, mk(fetch));
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://be:3000/api/media/analyze/a%20b%2Fc");
  });

  it("analyze sends model_name in body", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await tool("imaging.analyze").run({ fileId: "f1", model_name: "m1" }, mk(fetch));
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ model_name: "m1" });
  });

  it("extra args rejected", () => {
    expect(validateArgs(tool("imaging.request_review"), { fileId: "f1", extra: 1 })).toContain("unexpected argument: extra");
    expect(validateArgs(tool("imaging.request_review"), {})).toContain("missing required argument: fileId");
  });

  it("alerts.create enforces backend limits and posts body", async () => {
    const t = tool("alerts.create");
    const ok = {
      patient_id: "p1",
      source_id: "s1",
      severity: "HIGH",
      title: "t",
      summary: "s",
      jev_probabilities: { a: 0.9 },
      audit_id: "au1",
    };
    expect(validateArgs(t, ok)).toEqual([]);
    expect(validateArgs(t, { ...ok, severity: "LOW" }).length).toBe(1);
    expect(validateArgs(t, { ...ok, title: "x".repeat(201) }).length).toBe(1);
    expect(validateArgs(t, { ...ok, summary: "x".repeat(2001) }).length).toBe(1);
    expect(validateArgs(t, { ...ok, jev_probabilities: { k: "x".repeat(4000) } }).length).toBe(1);
    const fetch = vi.fn(async () => json(201, { id: "a" }));
    await t.run(ok, mk(fetch));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://be:3000/api/alerts/agent");
    expect(JSON.parse(init.body as string)).toEqual(ok);
  });

  it('toolForAction("ignore") === undefined', () => {
    expect(toolForAction("ignore")).toBeUndefined();
    expect(toolForAction("alert")?.name).toBe("alerts.create");
  });
});
