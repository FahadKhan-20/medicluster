import { describe, expect, it, vi } from "vitest";
import { JevClient, choice, fallbackAnswer, noul, score } from "../src/judge/jev.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const client = (fetch: typeof globalThis.fetch) =>
  new JevClient({ apiKey: "k1", model: "typesafe/jev-1.13", fetch, backoffMs: 0 });

describe("JevClient", () => {
  it("posts to /alpha/decisions with meta stripped", async () => {
    const fetch = vi.fn(async () => json(200, { answers: { a: { type: "noul", noul: 0.9 } } }));
    await client(fetch).decide({ s: 1 }, { a: noul("q?", { secret: true }) });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.questions.a).toEqual({ type: "noul", instructions: "q?" });
    expect("meta" in body.questions.a).toBe(false);
  });

  it("returns answers and cost", async () => {
    const fetch = vi.fn(async () =>
      json(200, { answers: { a: { type: "noul", noul: 0.97 } }, usage: { cost: 0.0012 } }),
    );
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(r.answers.a.noul).toBe(0.97);
    expect(r.cost).toBe(0.0012);
    expect(r.fallback).toBe(false);
  });

  it("fallback shapes match cse/jev.py", () => {
    expect(fallbackAnswer(noul("q"))).toEqual({ type: "noul", noul: 0.5 });
    expect(fallbackAnswer(choice("q", { x: "X", y: "Y" }))).toEqual({
      type: "choice",
      choice: "x",
      probabilities: { x: 0.5, y: 0.5 },
      confidence: 0,
    });
    expect(fallbackAnswer(score("q", ["a", "b", "c"]))).toEqual({
      type: "score",
      score: 1,
      probabilities: { "0": 1 / 3, "1": 1 / 3, "2": 1 / 3 },
      confidence: 0,
    });
  });

  it("401 falls back without retry", async () => {
    const fetch = vi.fn(async () => json(401, { error: "no" }));
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.fallback).toBe(true);
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.5 });
    expect(r.cost).toBe(0);
  });

  it("500 retries twice then falls back", async () => {
    const fetch = vi.fn(async () => json(500, { error: "boom" }));
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(r.fallback).toBe(true);
  });

  it("retries 429 then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, { answers: { a: { type: "noul", noul: 0.8 } } }));
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r.fallback).toBe(false);
  });

  it("network error never throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(r.fallback).toBe(true);
    expect(r.error).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("malformed 200 body falls back", async () => {
    const fetch = vi.fn(async () => json(200, { nope: 1 }));
    const r = await client(fetch).decide({}, { a: noul("q") });
    expect(r.fallback).toBe(true);
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.5 });
  });

  it("a question missing from the response gets the neutral answer", async () => {
    const fetch = vi.fn(async () => json(200, { answers: { a: { type: "noul", noul: 0.99 } } }));
    const r = await client(fetch).decide({}, { a: noul("q"), b: noul("q2") });
    expect(r.answers.a.noul).toBe(0.99);
    expect(r.answers.b).toEqual({ type: "noul", noul: 0.5 });
  });

  it("circular state falls back without throwing", async () => {
    const fetch = vi.fn();
    const state: Record<string, unknown> = {};
    state.self = state;
    const r = await client(fetch).decide(state, { a: noul("q") });
    expect(r.fallback).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.5 });
    expect(fetch).not.toHaveBeenCalled();
  });

  const one = async (q: ReturnType<typeof noul>, answer: unknown) => {
    const fetch = vi.fn(async () => json(200, { answers: { a: answer } }));
    return client(fetch).decide({}, { a: q });
  };

  it("string noul is replaced by fallback", async () => {
    const r = await one(noul("q"), { type: "noul", noul: "0.99" });
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.5 });
    expect(r.fallback).toBe(false);
    expect(r.error).toContain("a");
  });

  it("out-of-range noul is replaced by fallback", async () => {
    expect((await one(noul("q"), { type: "noul", noul: 1.5 })).answers.a.noul).toBe(0.5);
  });

  it("wrong type is replaced by fallback", async () => {
    const r = await one(noul("q"), { type: "score", score: 1 });
    expect(r.answers.a).toEqual({ type: "noul", noul: 0.5 });
    expect((await one(noul("q"), [])).answers.a).toEqual({ type: "noul", noul: 0.5 });
  });

  it("unknown choice key is replaced by fallback", async () => {
    const q = choice("q", { x: "X", y: "Y" });
    const r = await one(q, { type: "choice", choice: "z", probabilities: { z: 1 } });
    expect(r.answers.a.choice).toBe("x");
    expect(r.answers.a.confidence).toBe(0);
    const ok = await one(q, { type: "choice", choice: "y", probabilities: { x: 0.1, y: 0.9 } });
    expect(ok.answers.a.choice).toBe("y");
    expect(ok.error).toBeUndefined();
  });

  it("non-finite score is replaced by fallback", async () => {
    const r = await one(score("q", ["a", "b", "c"]), { type: "score", score: "2" });
    expect(r.answers.a.score).toBe(1);
  });
});
