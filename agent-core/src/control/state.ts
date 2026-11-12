import { McStore } from "../store/mc.js";

// TODO(Task 10): replace with the real Event type.
export type QueuedEvent = { id: string; notBefore?: string; attempts?: number; [k: string]: unknown };

const COLLECTION = "agent_state";
const ID = "agent-core";

export class AgentState {
  constructor(private store: McStore) {}

  private async doc(): Promise<any> {
    return (await this.store.find(COLLECTION, { _id: ID }, {}, 1))[0] ?? {};
  }

  private set(fields: object): Promise<any> {
    return this.store.upsert(COLLECTION, { _id: ID }, { $set: fields });
  }

  async isStopped(): Promise<boolean> {
    return (await this.doc()).stopped === true;
  }

  async setStopped(b: boolean): Promise<void> {
    await this.set({ stopped: b });
  }

  async cursor(): Promise<string | null> {
    return (await this.doc()).cursor ?? null;
  }

  async setCursor(iso: string): Promise<void> {
    await this.set({ cursor: iso });
  }

  /** Each queued event is its own doc, so re-enqueueing the same id keeps one doc. */
  async enqueue(event: QueuedEvent, notBefore?: string, attempts?: number): Promise<void> {
    const docId = `queue:${event.id}`;
    const existing = (await this.store.find(COLLECTION, { _id: docId }, {}, 1))[0];
    const currentAttempts = attempts ?? (typeof existing?.attempts === "number" ? existing.attempts : 0);
    await this.store.upsert(
      COLLECTION,
      { _id: docId },
      {
        $set: {
          event,
          status: "queued",
          queuedAt: existing?.queuedAt ?? new Date().toISOString(),
          attempts: currentAttempts,
          ...(notBefore ? { notBefore } : existing?.notBefore ? { notBefore: existing.notBefore } : {}),
        },
      },
    );
  }

  /** Returns queued events (oldest first) without removing them; call ack() when handled. */
  async drain(opts?: { dueOnly?: boolean; now?: string }): Promise<QueuedEvent[]> {
    const docs = await this.store.find(COLLECTION, { status: "queued" }, { queuedAt: 1 }, 200);
    const now = opts?.now ?? new Date().toISOString();
    const eligible = opts?.dueOnly ? docs.filter((d) => !d.notBefore || d.notBefore <= now) : docs;
    return eligible.map((d) => ({
      ...(d.event as QueuedEvent),
      ...(d.notBefore ? { notBefore: d.notBefore } : {}),
      ...(d.attempts !== undefined ? { attempts: d.attempts } : {}),
    }));
  }

  async getQueueItem(eventId: string): Promise<{ attempts: number; notBefore?: string; status: string } | null> {
    const docs = await this.store.find(COLLECTION, { _id: `queue:${eventId}` }, {}, 1);
    if (!docs[0]) return null;
    return {
      attempts: docs[0].attempts ?? 0,
      notBefore: docs[0].notBefore,
      status: docs[0].status,
    };
  }

  async markFailed(eventId: string, reason?: string): Promise<void> {
    await this.store.update(
      COLLECTION,
      { _id: `queue:${eventId}` },
      { $set: { status: "failed", failedAt: new Date().toISOString(), reason } },
    );
  }

  async ack(eventId: string): Promise<void> {
    await this.store.update(COLLECTION, { _id: `queue:${eventId}` }, { $set: { status: "acked" } });
  }

  async isDone(key: string): Promise<boolean> {
    return (await this.store.find(COLLECTION, { _id: `done:${key}` }, {}, 1)).length > 0;
  }

  async markDone(key: string): Promise<void> {
    await this.store.upsert(COLLECTION, { _id: `done:${key}` }, { $set: { doneAt: new Date().toISOString() } });
  }

  async isDecided(eventId: string): Promise<boolean> {
    return (await this.store.find(COLLECTION, { _id: `decided:${eventId}` }, {}, 1)).length > 0;
  }

  async markDecided(eventId: string, outcome: string): Promise<void> {
    await this.store.upsert(
      COLLECTION,
      { _id: `decided:${eventId}` },
      { $set: { outcome, decidedAt: new Date().toISOString() } },
    );
  }
}
