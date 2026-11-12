import { describe, it, expect } from "vitest";
import { JevClient, noul } from "../src/judge/jev.js";

const ok = () => new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } }, usage: { cost: 0.001 } }), { status: 200 });

describe("Jev fallback keys", () => {
  it("rotates to the next key on 402 and keeps using it", async () => {
    const seen: string[] = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>).Authorization;
      seen.push(key);
      return key === "Bearer b" ? ok() : new Response("Insufficient credits", { status: 402 });
    }) as typeof globalThis.fetch;
    const jev = new JevClient({ apiKey: "a", fallbackKeys: ["b", "c"], model: "m", fetch, backoffMs: 0 });
    const r1 = await jev.decide({}, { q: noul("x") });
    expect(r1.fallback).toBe(false);
    const r2 = await jev.decide({}, { q: noul("x") });
    expect(r2.fallback).toBe(false);
    expect(seen).toEqual(["Bearer a", "Bearer b", "Bearer b"]);
  });

  it("returns the neutral fallback when every key is out of credit", async () => {
    const fetch = (async () => new Response("no credit", { status: 402 })) as typeof globalThis.fetch;
    const jev = new JevClient({ apiKey: "a", fallbackKeys: ["b"], model: "m", fetch, backoffMs: 0 });
    const r = await jev.decide({}, { q: noul("x") });
    expect(r.fallback).toBe(true);
    expect(r.error).toMatch(/402/);
  });

  it("does not rotate on 400 (bad request is not a key problem)", async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return new Response("bad", { status: 400 }); }) as typeof globalThis.fetch;
    const jev = new JevClient({ apiKey: "a", fallbackKeys: ["b"], model: "m", fetch, backoffMs: 0 });
    expect((await jev.decide({}, { q: noul("x") })).fallback).toBe(true);
    expect(calls).toBe(1);
  });
});
