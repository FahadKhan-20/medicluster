import { createClient } from "@supabase/supabase-js";
import type { McStore } from "../store/mc.js";
import type { AgentState } from "../control/state.js";

export type Event = {
  id: string;
  type: "scan.uploaded" | "scan.analyzed" | "service.down" | "service.up";
  mediaId?: string;
  analyzedAt?: string;
  doc?: any;
  service?: string;
  at: string;
};

const MEDIA = "patientmedias";
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const CATCH_UP_LIMIT = 200;

/** Realtime row as delivered by the subscription: `{collection, id, data}`. */
export type Row = { collection: string; id?: string; data: any };

export type RealtimePayload = { eventType?: string; new: Row; old?: any };
export type Subscribe = (onRow: (p: RealtimePayload) => void, onReconnect?: () => void) => () => void;

function analyzedAtOf(doc: any): string | undefined {
  const v = doc?.analysis?.analyzedAt;
  return typeof v === "string" && v ? v : undefined;
}

function mediaEvent(doc: any, type: Event["type"], analyzedAt?: string): Event | null {
  const mediaId = doc?._id;
  if (typeof mediaId !== "string") return null;
  return {
    id: `${mediaId}:${analyzedAt ?? "new"}`,
    type,
    mediaId,
    ...(analyzedAt ? { analyzedAt } : {}),
    doc,
    at: new Date().toISOString(),
  };
}

/**
 * Insert (no `old`) -> scan.uploaded. Update (`old` given) -> scan.analyzed when the doc
 * has analysis.analyzedAt; repeats are dropped by Event.id dedupe and downstream idempotency.
 */
export function rowToEvent(row: { collection: string; data: any }, old?: any): Event | null {
  if (row?.collection !== MEDIA) return null;
  if (old === undefined) return mediaEvent(row.data, "scan.uploaded");
  const analyzedAt = analyzedAtOf(row.data);
  return analyzedAt ? mediaEvent(row.data, "scan.analyzed", analyzedAt) : null;
}

/** A catch-up doc has no insert/update marker: analysed docs are analyzed, others uploaded. */
function docToEvent(doc: any): Event | null {
  const row = { collection: MEDIA, data: doc };
  return rowToEvent(row, analyzedAtOf(doc) ? {} : undefined);
}

export class EventSource {
  private store: McStore;
  private state: AgentState;
  private subscribe: Subscribe;
  private onError: (err: unknown) => void;
  private seen = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private handler?: (e: Event) => Promise<void> | void;
  private unsubscribe?: () => void;
  private cursor: string | null = null;

  constructor(opts: {
    store: McStore;
    state: AgentState;
    subscribe: Subscribe;
    onError?: (err: unknown) => void;
  }) {
    this.store = opts.store;
    this.state = opts.state;
    this.subscribe = opts.subscribe;
    this.onError = opts.onError ?? ((err) => console.error("[events]", err));
  }

  async start(onEvent: (e: Event) => Promise<void> | void): Promise<void> {
    this.handler = onEvent;
    this.cursor = await this.state.cursor();
    if (this.cursor === null) {
      this.cursor = new Date().toISOString();
      await this.state.setCursor(this.cursor);
    }
    this.unsubscribe = this.subscribe(
      (p) => this.enqueue(() => this.onRealtime(p)),
      () => this.enqueue(() => this.catchUp()),
    );
    await this.enqueue(() => this.catchUp());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.handler = undefined;
  }

  /** Serialises realtime and catch-up work so the cursor only ever moves forward in order. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((err) => this.onError(err));
    return this.chain;
  }

  private async onRealtime(p: RealtimePayload): Promise<void> {
    const isInsert = p.eventType === "INSERT";
    const event = rowToEvent(p.new, isInsert ? undefined : (p.old ?? {}));
    if (event) await this.deliver(event, p.new?.data?.updatedAt);
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const cursor = this.cursor ?? new Date(0).toISOString();
      const docs = await this.store.find(MEDIA, { updatedAt: { $gt: cursor } }, { updatedAt: 1 }, CATCH_UP_LIMIT);
      for (const doc of docs) {
        const event = docToEvent(doc);
        if (event) await this.deliver(event, doc.updatedAt);
        else await this.advance(doc.updatedAt);
      }
      if (docs.length < CATCH_UP_LIMIT || this.cursor === cursor) return;
    }
  }

  private async deliver(event: Event, updatedAt?: string): Promise<void> {
    const now = Date.now();
    for (const [id, ts] of this.seen) if (now - ts > DEDUPE_WINDOW_MS) this.seen.delete(id);
    if (!this.seen.has(event.id) && this.handler) {
      await this.handler(event);
      this.seen.set(event.id, now);
    }
    await this.advance(updatedAt);
  }

  private async advance(updatedAt?: string): Promise<void> {
    if (typeof updatedAt !== "string" || (this.cursor !== null && updatedAt <= this.cursor)) return;
    await this.state.setCursor(updatedAt);
    this.cursor = updatedAt;
  }
}

/** Thin wrapper over Supabase Realtime; not unit-tested against a live server. */
export function realtimeSubscribe(supabaseUrl: string, key: string): Subscribe {
  return (onRow, onReconnect) => {
    const supabase = createClient(supabaseUrl, key);
    let degraded = false;
    const channel = supabase
      .channel("agent-core")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medicluster_records", filter: "collection=eq.patientmedias" },
        (payload: any) => onRow({ eventType: payload.eventType, new: payload.new, old: payload.old }),
      )
      .subscribe((status: string) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") degraded = true;
        else if (status === "SUBSCRIBED" && degraded) {
          degraded = false;
          onReconnect?.();
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  };
}
