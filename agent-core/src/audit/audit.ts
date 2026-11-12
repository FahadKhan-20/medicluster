import { McStore } from "../store/mc.js";

const COLLECTION = "agent_audit";

export type AuditOutcome = "executed" | "review" | "skipped" | "pending" | "failed" | "blocked";

/** Append-only audit log: insert, append steps, set outcome. No edit or delete. */
export class Audit {
  constructor(private store: McStore) {}

  async start(event: object): Promise<string> {
    const doc = await this.store.insert(COLLECTION, {
      event,
      steps: [],
      outcome: "pending",
      startedAt: new Date().toISOString(),
    });
    return doc._id as string;
  }

  async append(auditId: string, step: { kind: string; data: object }): Promise<void> {
    await this.store.update(
      COLLECTION,
      { _id: auditId },
      { $push: { steps: { ...step, at: new Date().toISOString() } } },
    );
  }

  async finish(auditId: string, outcome: AuditOutcome, reason?: string): Promise<void> {
    await this.store.update(
      COLLECTION,
      { _id: auditId },
      { $set: { outcome, ...(reason !== undefined ? { reason } : {}), finishedAt: new Date().toISOString() } },
    );
  }

  list(since?: string, limit = 50): Promise<any[]> {
    const filter = since ? { startedAt: { $gt: since } } : {};
    return this.store.find(COLLECTION, filter, { startedAt: -1 }, limit);
  }
}
