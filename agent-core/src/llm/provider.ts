// LLM provider: Gemini via OmniRoute. Gemini only executes (builds fact-only state,
// fills tool arguments); it never decides. Failures surface as ProviderError and
// never include the API key or raw upstream bodies.

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface LlmProvider {
  json<T>(system: string, user: string): Promise<T>;
}

export interface OmniRouteOptions {
  url: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

function parseJsonContent(content: string): unknown {
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("model reply was not valid JSON");
  }
}

export class OmniRouteProvider implements LlmProvider {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(o: OmniRouteOptions) {
    this.url = `${o.url.replace(/\/+$/, "")}/v1/chat/completions`;
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? 500;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  private body(system: string, user: string, withFormat: boolean): string {
    return JSON.stringify({
      model: this.model,
      temperature: 0.2,
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  }

  async json<T>(system: string, user: string): Promise<T> {
    let withFormat = true;
    let fellBack = false;
    let lastError = "unknown error";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let retryable = true;
      try {
        const resp = await this.fetchFn(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: this.body(system, user, withFormat),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.status === 200) {
          const data = (await resp.json()) as { choices?: { message?: { content?: unknown } }[] };
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== "string" || !content.trim()) {
            throw new ProviderError("provider response had no message content");
          }
          return parseJsonContent(content) as T;
        }
        lastError = `provider HTTP ${resp.status}`;
        if ((resp.status === 400 || resp.status === 422) && withFormat && !fellBack) {
          // Same fallback CliniQ uses: retry once without response_format.
          withFormat = false;
          fellBack = true;
          attempt--;
          continue;
        }
        retryable = resp.status >= 500 || resp.status === 429;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        lastError = `provider request failed (${e instanceof Error ? e.name : "error"})`;
      }
      if (!retryable) break;
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
    }
    throw new ProviderError(lastError);
  }
}

/** Test double: `rules(system, user) -> value`. */
export class FakeLlm implements LlmProvider {
  calls: { system: string; user: string }[] = [];

  constructor(private readonly rules: (system: string, user: string) => unknown) {}

  async json<T>(system: string, user: string): Promise<T> {
    this.calls.push({ system, user });
    return this.rules(system, user) as T;
  }
}
