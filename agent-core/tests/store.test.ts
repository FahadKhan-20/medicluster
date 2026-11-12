import { describe, it, expect, vi } from "vitest";
import { McStore, supabaseRpc, type Rpc } from "../src/store/mc.js";
import { Audit } from "../src/audit/audit.js";
import { AgentState } from "../src/control/state.js";

function fakeRpc() {
  const db = new Map<string, Map<string, any>>();
  const calls: { name: string; args: any }[] = [];
  const col = (c: string) => db.get(c) ?? db.set(c, new Map()).get(c)!;
  const match = (d: any, f: any) => Object.entries(f).every(([k, v]) => {
    if (v && typeof v === "object" && "$gt" in (v as any)) return d[k] > (v as any).$gt;
    return d[k] === v;
  });
  const rpc: Rpc = async (name, a: any) => {
    calls.push({ name, args: a });
    const c = col(a.p_collection);
    if (name === "mc_find") {
      const [sk] = Object.keys(a.p_sort ?? {});
      const rows = [...c.values()].filter((d) => match(d, a.p_filter));
      if (sk) rows.sort((x, y) => (x[sk] < y[sk] ? -1 : x[sk] > y[sk] ? 1 : 0) * a.p_sort[sk]);
      return rows.slice(0, a.p_limit)
        .map((d) => structuredClone(d));
    }
    if (a.p_action === "insert") {
      c.set(a.p_document._id, structuredClone(a.p_document));
      return a.p_document;
    }
    let t = [...c.values()].find((d) => match(d, a.p_filter));
    if (!t) {
      if (!a.p_upsert) return null;
      t = { ...a.p_filter };
      c.set(t._id, t);
    }
    Object.assign(t, a.p_update.$set ?? {});
    for (const [k, v] of Object.entries(a.p_update.$push ?? {})) (t[k] ??= []).push(v);
    return structuredClone(t);
  };
  return { rpc, calls, db };
}

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

  it("rpc headers", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    await supabaseRpc("http://sb/", "sb_secret_x", f as any)("mc_find", {});
    let [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://sb/rest/v1/rpc/mc_find");
    expect(init.headers.apikey).toBe("sb_secret_x");
    expect(init.headers.authorization).toBeUndefined();
    await supabaseRpc("http://sb", "eyJ.a.b", f as any)("mc_find", {});
    init = (f.mock.calls[1] as any)[1];
    expect(init.headers.apikey).toBe("eyJ.a.b");
    expect(init.headers.authorization).toBe("Bearer eyJ.a.b");
  });
});
