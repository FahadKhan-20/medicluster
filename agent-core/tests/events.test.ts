import { describe, it, expect, vi, afterEach } from "vitest";
import { rowToEvent, EventSource, type RealtimePayload } from "../src/events/events.js";
import { HealthPoller } from "../src/events/health.js";

const media = (extra: object = {}) => ({ _id: "m1", updatedAt: "2026-01-01T00:00:10.000Z", ...extra });
const analyzed = media({ analysis: { analyzedAt: "2026-01-01T00:00:09.000Z" } });

describe("rowToEvent", () => {
  it("insert maps to scan.uploaded", () => {
    const e = rowToEvent({ collection: "patientmedias", data: media() });
    expect(e).toMatchObject({ type: "scan.uploaded", mediaId: "m1", id: "m1:new" });
  });
  it("analysis change maps to scan.analyzed", () => {
    const e = rowToEvent({ collection: "patientmedias", data: analyzed }, { id: "m1" });
    expect(e).toMatchObject({ type: "scan.analyzed", id: "m1:2026-01-01T00:00:09.000Z", analyzedAt: "2026-01-01T00:00:09.000Z" });
    expect(e?.doc).toBe(analyzed);
  });
  it("other collection is null", () => {
    expect(rowToEvent({ collection: "patients", data: media() })).toBeNull();
  });
  it("update without analyzedAt is null", () => {
    expect(rowToEvent({ collection: "patientmedias", data: media() }, { id: "m1" })).toBeNull();
  });
});

function setup(docs: any[], cursor: string | null = "2026-01-01T00:00:00.000Z") {
  let onRow!: (p: RealtimePayload) => void;
  let onReconnect!: () => void;
  const store = { find: vi.fn(async () => docs) } as any;
  const state = { cursor: vi.fn(async () => cursor), setCursor: vi.fn(async () => {}) } as any;
  const subscribe = (r: any, rc: any) => {
    onRow = r;
    onReconnect = rc;
    return () => {};
  };
  const onError = vi.fn();
  const src = new EventSource({ store, state, subscribe, onError, retryMs: 0 });
  return { src, store, state, onError, row: (p: RealtimePayload) => onRow(p), reconnect: () => onReconnect() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("EventSource", () => {
  it("dedupes overlapping realtime and catch-up rows", async () => {
    const t = setup([]);
    const onEvent = vi.fn(async () => {});
    await t.src.start(onEvent);
    t.row({ eventType: "INSERT", new: { collection: "patientmedias", id: "m1", data: media() } });
    await flush();
    t.store.find.mockResolvedValueOnce([media()]);
    t.reconnect();
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("repeated update with same analyzedAt dedupes to one event", async () => {
    const t = setup([]);
    const onEvent = vi.fn(async () => {});
    await t.src.start(onEvent);
    const p: RealtimePayload = { eventType: "UPDATE", new: { collection: "patientmedias", id: "m1", data: analyzed }, old: { id: "m1" } };
    t.row(p);
    t.row(p);
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("cursor advances only after handler resolves", async () => {
    const t = setup([media()]);
    await t.src.start(async () => {
      throw new Error("boom");
    });
    expect(t.state.setCursor).not.toHaveBeenCalled();
    expect(t.onError).toHaveBeenCalled();
    t.src.stop();

    const ok = setup([media()]);
    await ok.src.start(async () => {});
    expect(ok.state.setCursor).toHaveBeenCalledWith("2026-01-01T00:00:10.000Z");
  });

  it("reconnect runs catch-up", async () => {
    const t = setup([]);
    await t.src.start(async () => {});
    expect(t.store.find).toHaveBeenCalledTimes(1);
    t.reconnect();
    await flush();
    expect(t.store.find).toHaveBeenCalledTimes(2);
    expect(t.store.find).toHaveBeenLastCalledWith("patientmedias", { updatedAt: { $gt: "2026-01-01T00:00:00.000Z" } }, { updatedAt: 1 }, 200);
  });

  it("null cursor initialises to now without backfill", async () => {
    const t = setup([], null);
    await t.src.start(async () => {});
    expect(t.state.setCursor).toHaveBeenCalledTimes(1);
    const iso = (t.state.setCursor as any).mock.calls[0][0];
    expect(Math.abs(Date.parse(iso) - Date.now())).toBeLessThan(5000);
    expect((t.store.find as any).mock.calls[0][1]).toEqual({ updatedAt: { $gt: iso } });
  });
});

describe("EventSource failure handling", () => {
  const mk = (id: string, t: string) => ({ _id: id, updatedAt: t });
  const A = mk("a", "2026-01-01T00:00:10.000Z");
  const B = mk("b", "2026-01-01T00:00:20.000Z");
  const ins = (d: any): RealtimePayload => ({ eventType: "INSERT", new: { collection: "patientmedias", id: d._id, data: d } });

  it("failed row is redelivered after a later row succeeds", async () => {
    const t = setup([]);
    const seen: string[] = [];
    let failA = true;
    await t.src.start(async (e) => {
      if (e.mediaId === "a" && failA) {
        failA = false;
        throw new Error("boom");
      }
      seen.push(e.mediaId!);
    });
    t.store.find.mockResolvedValue([A, B]);
    t.row(ins(A));
    t.row(ins(B));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["b", "a"]);
    expect(t.state.setCursor).toHaveBeenLastCalledWith(B.updatedAt);
  });

  it("cursor does not advance while stalled", async () => {
    const t = setup([]);
    await t.src.start(async (e) => {
      if (e.mediaId === "a") throw new Error("boom");
    });
    t.store.find.mockResolvedValue([]);
    t.row(ins(A));
    t.row(ins(B));
    await flush();
    expect(t.state.setCursor).not.toHaveBeenCalled();
    t.src.stop();
  });

  it("stop prevents advance of queued events", async () => {
    const t = setup([]);
    const onEvent = vi.fn(async () => {});
    await t.src.start(onEvent);
    t.row(ins(A));
    t.row(ins(B));
    t.src.stop();
    await flush();
    expect(onEvent).not.toHaveBeenCalled();
    expect(t.state.setCursor).not.toHaveBeenCalled();
  });
});

describe("HealthPoller", () => {
  afterEach(() => vi.useRealTimers());

  it("health emits on change only", async () => {
    vi.useFakeTimers();
    let status = 200;
    const fetch = vi.fn(async () => ({ ok: status === 200, status })) as any;
    const p = new HealthPoller({ targets: { ml: "http://ml/health" }, intervalMs: 1000, fetch });
    const events: any[] = [];
    await p.start((e) => void events.push(e));
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(0);
    status = 500;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.map((e) => e.type)).toEqual(["service.down"]);
    expect(p.isUp("ml")).toBe(false);
    status = 200;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.map((e) => e.type)).toEqual(["service.down", "service.up"]);
    expect(p.isUp("ml")).toBe(true);
    p.stop();
  });

  it("401 counts as up", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new HealthPoller({ targets: { intelligence: "http://i/" }, fetch });
    const events: any[] = [];
    await p.start((e) => void events.push(e));
    p.stop();
    expect(events).toHaveLength(0);
    expect(p.isUp("intelligence")).toBe(true);
  });
});
