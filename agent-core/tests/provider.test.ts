import { describe, expect, it, vi } from "vitest";
import { FakeLlm, OmniRouteProvider, ProviderError } from "../src/llm/provider.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reply = (content: string) => json(200, { choices: [{ message: { content } }] });

const make = (fetch: typeof globalThis.fetch) =>
  new OmniRouteProvider({ url: "http://omni:20128/", apiKey: "secret-key", model: "m1", fetch, backoffMs: 0 });

describe("OmniRouteProvider", () => {
  it("posts chat completion", async () => {
    const fetch = vi.fn(async () => reply('{"a":1}'));
    await make(fetch).json("SYS", "USR");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://omni:20128/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("m1");
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
  });

  it("parses JSON content", async () => {
    expect(await make(vi.fn(async () => reply('{"a":1}'))).json("s", "u")).toEqual({ a: 1 });
  });

  it("strips json code fence", async () => {
    expect(await make(vi.fn(async () => reply('```json\n{"a":1}\n```'))).json("s", "u")).toEqual({ a: 1 });
  });

  it("non-JSON reply is a provider failure", async () => {
    await expect(make(vi.fn(async () => reply("Sure, here it is"))).json("s", "u")).rejects.toBeInstanceOf(ProviderError);
  });

  it("retries twice on 5xx then throws ProviderError without leaking secrets", async () => {
    const fetch = vi.fn(async () => json(503, { error: "upstream body secret-key" }));
    const err = await make(fetch).json("s", "u").catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain("secret-key");
    expect(err.message).not.toContain("upstream body");
  });

  it("retries twice on network/timeout errors then throws", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(make(fetch).json("s", "u")).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("400 retries once without response_format", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(400, { error: "bad" }))
      .mockResolvedValueOnce(reply('{"a":2}'));
    expect(await make(fetch).json("s", "u")).toEqual({ a: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect("response_format" in second).toBe(false);
  });

  it("422 then 422 throws after exactly one fallback", async () => {
    const fetch = vi.fn(async () => json(422, {}));
    await expect(make(fetch).json("s", "u")).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("401 is not retried", async () => {
    const fetch = vi.fn(async () => json(401, {}));
    await expect(make(fetch).json("s", "u")).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("missing content is a provider failure", async () => {
    await expect(make(vi.fn(async () => json(200, { choices: [] }))).json("s", "u")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("FakeLlm", () => {
  it("returns the rule output", async () => {
    const f = new FakeLlm((s, u) => ({ s, u }));
    expect(await f.json("a", "b")).toEqual({ s: "a", u: "b" });
  });
});
