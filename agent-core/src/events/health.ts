import type { Event } from "./events.js";

export class HealthPoller {
  private targets: Record<string, string>;
  private intervalMs: number;
  private fetchImpl: typeof fetch;
  private up = new Map<string, boolean>();
  private timer?: ReturnType<typeof setInterval>;
  private listeners: ((e: Event) => Promise<void> | void)[] = [];

  constructor(opts: { targets: Record<string, string>; intervalMs?: number; fetch?: typeof fetch }) {
    this.targets = opts.targets;
    this.intervalMs = opts.intervalMs ?? 15000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Services are assumed up until a poll says otherwise. */
  isUp(name: string): boolean {
    return this.up.get(name) ?? true;
  }

  addListener(listener: (e: Event) => Promise<void> | void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async start(onEvent: (e: Event) => Promise<void> | void): Promise<void> {
    await this.poll(onEvent);
    this.timer = setInterval(() => void this.poll(onEvent), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(url: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }

  private async poll(onEvent: (e: Event) => Promise<void> | void): Promise<void> {
    await Promise.all(
      Object.entries(this.targets).map(async ([service, url]) => {
        const nowUp = await this.check(url);
        if (nowUp === this.isUp(service)) return;
        this.up.set(service, nowUp);
        const at = new Date().toISOString();
        const type = nowUp ? "service.up" : "service.down";
        const event: Event = { id: `${service}:${nowUp ? "up" : "down"}:${at}`, type, service, at };
        try {
          await onEvent(event);
        } catch {
          // a failing handler must not stop health polling
        }
        for (const listener of this.listeners) {
          try {
            await listener(event);
          } catch {
            // listener failure must not stop others
          }
        }
      }),
    );
  }
}
