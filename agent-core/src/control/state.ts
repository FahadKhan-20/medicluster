import { McStore } from "../store/mc.js";

// TODO(Task 10): replace with the real Event type.
export type QueuedEvent = { id: string; [k: string]: unknown };

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
  async enqueue(event: QueuedEvent): Promise<void> {
    await this.store.upsert(
      COLLECTION,
      { _id: `queue:${event.id}` },
      { $set: { event, status: "queued", queuedAt: new Date().toISOString() } },
    );
  }

  /** Returns queued events (oldest first) without removing them; call ack() when handled. */
  async drain(): Promise<QueuedEvent[]> {
    const docs = await this.store.find(COLLECTION, { status: "queued" }, { queuedAt: 1 }, 200);
    return docs.map((d) => d.event as QueuedEvent);
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
}
