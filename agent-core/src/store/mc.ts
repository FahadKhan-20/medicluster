import { randomUUID } from "node:crypto";

export interface Rpc {
  (name: string, args: object): Promise<unknown>;
}

export function supabaseRpc(url: string, key: string, fetchImpl: typeof fetch = fetch): Rpc {
  const base = url.replace(/\/+$/, "");
  return async (name, args) => {
    const headers: Record<string, string> = { "content-type": "application/json", apikey: key };
    if (!key.startsWith("sb_secret_")) headers.authorization = `Bearer ${key}`;
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`rpc ${name} failed: ${res.status} ${await res.text().catch(() => "")}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/** Record store over mc_find/mc_write. Deliberately has no delete. */
export class McStore {
  constructor(private rpc: Rpc) {}

  async find(collection: string, filter: object = {}, sort: object = {}, limit = 100): Promise<any[]> {
    const out = await this.rpc("mc_find", {
      p_collection: collection,
      p_filter: filter,
      p_sort: sort,
      p_limit: limit,
      p_skip: 0,
    });
    return Array.isArray(out) ? out : [];
  }

  private write(collection: string, action: string, extra: object): Promise<any> {
    return this.rpc("mc_write", {
      p_collection: collection,
      p_action: action,
      p_filter: {},
      p_update: {},
      p_document: {},
      p_upsert: false,
      p_return_new: true,
      ...extra,
    });
  }

  insert(collection: string, doc: Record<string, unknown>): Promise<any> {
    const document = { ...doc, _id: typeof doc._id === "string" ? doc._id : randomUUID() };
    return this.write(collection, "insert", { p_document: document });
  }

  update(collection: string, filter: object, update: object): Promise<any> {
    return this.write(collection, "update", { p_filter: filter, p_update: update });
  }

  upsert(collection: string, filter: object, update: object): Promise<any> {
    return this.write(collection, "update", { p_filter: filter, p_update: update, p_upsert: true });
  }
}
