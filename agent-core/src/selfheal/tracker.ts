export const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_MAX_RESTARTS = 3;

export class RestartTracker {
  private history = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts?: { windowMs?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  getRestarts(service: string): number[] {
    const t = this.now();
    const list = (this.history.get(service) ?? []).filter((ts) => t - ts < this.windowMs);
    this.history.set(service, list);
    return list;
  }

  canRestart(service: string, max = DEFAULT_MAX_RESTARTS): boolean {
    return this.getRestarts(service).length < max;
  }

  recordRestart(service: string): void {
    const list = this.getRestarts(service);
    list.push(this.now());
    this.history.set(service, list);
  }

  reset(service?: string): void {
    if (service) {
      this.history.delete(service);
    } else {
      this.history.clear();
    }
  }
}
