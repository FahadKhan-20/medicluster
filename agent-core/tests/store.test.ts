import { describe, it, expect, vi } from "vitest";
import { McStore, supabaseRpc } from "../src/store/mc.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";
import { fakeRpc } from "./helpers/fakeRpc.js";

describe("store", () => {
  it("audit is append-only", async () => {
    const { rpc, calls } = fakeRpc();
    const audit = Audit.prototype;
    expect(Object.getOwnPropertyNames(audit).sort()).toEqual(["append", "constructor", "finish", "list", "start"]);
    const a = new Audit(new McStore(rpc));
    const id = await a.start({ id: "e1" });
    await a.append(id, { kind: "jev", data: { x: 1 } });
    const w = calls.filter((c) => c.name === "mc_write").at(-1)!.args;
    expect(w.p_action).toBe("update");
    expect(Object.keys(w.p_update)).toEqual(["$push"]);
    expect(Object.keys(w.p_update.$push)).toEqual(["steps"]);
    await a.finish(id, "executed", "ok");
    const [doc] = await a.list();
    expect(doc.steps).toHaveLength(1);
    expect(doc.outcome).toBe("executed");
  });

  it("McStore has no delete", () => {
    expect("delete" in new McStore(fakeRpc().rpc)).toBe(false);
  });

  it("stopped flag persists", async () => {
    const { rpc } = fakeRpc();
    const s1 = new AgentState(new McStore(rpc));
    expect(await s1.isStopped()).toBe(false);
    await s1.setStopped(true);
    expect(await new AgentState(new McStore(rpc)).isStopped()).toBe(true);
  });

  it("cursor round-trips", async () => {
    const s = new AgentState(new McStore(fakeRpc().rpc));
    expect(await s.cursor()).toBeNull();
    await s.setCursor("2026-01-01T00:00:00.000Z");
    expect(await s.cursor()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("drain does not remove until ack", async () => {
    const s = new AgentState(new McStore(fakeRpc().rpc));
    await s.enqueue({ id: "a" });
    await s.enqueue({ id: "b" });
    expect(await s.drain()).toHaveLength(2);
    expect(await s.drain()).toHaveLength(2);
    await s.ack("a");
    const left = await s.drain();
    expect(left.map((e) => e.id)).toEqual(["b"]);
  });

  it("enqueue same id twice keeps one", async () => {
    const { rpc, db } = fakeRpc();
    const s = new AgentState(new McStore(rpc));
    await s.enqueue({ id: "a" });
    await s.ack("a");
    await s.enqueue({ id: "a" });
    expect([...db.get("agent_state")!.keys()]).toEqual(["queue:a"]);
    expect(await s.drain()).toHaveLength(1);
  });

  it("done keys", async () => {
    const s = new AgentState(new McStore(fakeRpc().rpc));
    expect(await s.isDone("k")).toBe(false);
    await s.markDone("k");
    expect(await s.isDone("k")).toBe(true);
  });

  it("markDone twice keeps one doc", async () => {
    const { rpc, db } = fakeRpc();
    const s = new AgentState(new McStore(rpc));
    await s.markDone("k");
    await s.markDone("k");
    expect([...db.get("agent_state")!.keys()]).toEqual(["done:k"]);
  });

  it("singleton doc has no done or queue fields after markDone/enqueue", async () => {
    const { rpc, db } = fakeRpc();
    const s = new AgentState(new McStore(rpc));
    await s.setStopped(true);
    await s.markDone("k");
    await s.enqueue({ id: "a" });
    expect(Object.keys(db.get("agent_state")!.get("agent-core")).sort()).toEqual(["_id", "stopped"]);
  });

  it("rpc headers and timeout signal", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    await supabaseRpc("http://sb/", "sb_secret_x", f as any)("mc_find", {});
    let [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://sb/rest/v1/rpc/mc_find");
    expect(init.headers.apikey).toBe("sb_secret_x");
    expect(init.headers.authorization).toBeUndefined();
    expect(init.signal).toBeDefined();
    await supabaseRpc("http://sb", "eyJ.a.b", f as any)("mc_find", {});
    init = (f.mock.calls[1] as any)[1];
    expect(init.headers.apikey).toBe("eyJ.a.b");
    expect(init.headers.authorization).toBe("Bearer eyJ.a.b");
  });

  it("decided markers persist outcome", async () => {
    const s = new AgentState(new McStore(fakeRpc().rpc));
    expect(await s.isDecided("ev1")).toBe(false);
    await s.markDecided("ev1", "executed");
    expect(await s.isDecided("ev1")).toBe(true);
  });

  it("drain with dueOnly filters notBefore", async () => {
    const s = new AgentState(new McStore(fakeRpc().rpc));
    const now = "2026-01-01T00:00:00.000Z";
    const future = "2026-01-01T00:02:00.000Z";
    await s.enqueue({ id: "due" }, now);
    await s.enqueue({ id: "not_due" }, future);
    expect(await s.drain()).toHaveLength(2);
    const due = await s.drain({ dueOnly: true, now });
    expect(due.map((e) => e.id)).toEqual(["due"]);
  });
});
