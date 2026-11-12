// The only path by which the agent changes MediCluster data: authenticated backend HTTP routes.
// 5xx and network errors are retried; 4xx never. The token is never included in errors or results.

export type BackendResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; retryable: false };

export interface BackendOptions {
  baseUrl: string;
  /** Called on every request so the bearer token is always freshly signed. */
  token: () => string;
  fetch?: typeof globalThis.fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly token: () => string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(o: BackendOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token;
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.retries = o.retries ?? 3;
    this.backoffMs = o.backoffMs ?? 500;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  async call(method: string, path: string, body?: unknown): Promise<BackendResult> {
    const url = `${this.baseUrl}${path}`;
    let status = 0;
    let error = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.token()}` };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const resp = await this.fetchFn(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = resp.status;
        if (resp.ok) {
          const text = await resp.text().catch(() => "");
          let data: unknown = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          return { ok: true, status, data };
        }
        error = `HTTP ${status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`;
        if (status < 500) return { ok: false, status, error, retryable: false };
      } catch (e) {
        status = 0;
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
    }
    return { ok: false, status, error: error || "unknown error", retryable: false };
  }
}
