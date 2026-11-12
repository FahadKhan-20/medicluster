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

  async enqueue(event: QueuedEvent): Promise<void> {
    await this.store.upsert(COLLECTION, { _id: ID }, { $push: { queue: event } });
  }

  /** Returns queued events and clears the queue. */
  async drain(): Promise<QueuedEvent[]> {
    const queue: QueuedEvent[] = (await this.doc()).queue ?? [];
    if (queue.length === 0) return [];
    await this.set({ queue: [] });
    return queue;
  }

  async isDone(key: string): Promise<boolean> {
    return ((await this.doc()).done ?? []).includes(key);
  }

  async markDone(key: string): Promise<void> {
    await this.store.upsert(COLLECTION, { _id: ID }, { $push: { done: key } });
  }
}
