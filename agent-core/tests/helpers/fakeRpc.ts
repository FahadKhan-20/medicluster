import type { Rpc } from "../../src/store/mc.js";

/** In-memory mc_find/mc_write double (equality and $gt filters, $set/$push updates). */
export function fakeRpc() {
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
