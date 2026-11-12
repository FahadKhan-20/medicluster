import { describe, it, expect } from "vitest";
import { trackInFlight } from "../src/lifecycle.js";

describe("trackInFlight", () => {
  it("drain waits for in-flight work", async () => {
    const t = trackInFlight();
    let release!: () => void;
    let done = false;
    const fn = t.wrap(
      (x: number) =>
        new Promise<number>((r) => {
          release = () => {
            done = true;
            r(x);
          };
        }),
    );
    const p = fn(7);
    let drained = false;
    const d = t.drain().then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);
    release();
    expect(await p).toBe(7);
    await d;
    expect(done && drained).toBe(true);
  });

  it("drain resolves when nothing in flight", async () => {
    await expect(trackInFlight().drain()).resolves.toBeUndefined();
  });

  it("drain settles even if work rejects, and wrap still rejects to caller", async () => {
    const t = trackInFlight();
    const p = t.wrap(async () => {
      throw new Error("boom");
    })();
    await expect(p).rejects.toThrow("boom");
    await expect(t.drain()).resolves.toBeUndefined();
  });
});
