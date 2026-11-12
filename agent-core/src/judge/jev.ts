// Decision layer: Jev (typesafe/jev-1.13) via OpenRouter's decisions endpoint.
// Port of cse/jev.py. Any failure yields the neutral fallback, which must never execute.

export type Question = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
  meta?: object;
};

export type Answer = {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type DecideResult = {
  answers: Record<string, Answer>;
  cost: number;
  fallback: boolean;
  error?: string;
};

export interface Decider {
  decide(state: unknown, questions: Record<string, Question>, purpose?: string): Promise<DecideResult>;
}

const withMeta = <T extends object>(q: T, meta?: object): T & { meta?: object } =>
  meta && Object.keys(meta).length ? { ...q, meta } : q;

export const noul = (instructions: string, meta?: object): Question =>
  withMeta({ type: "noul" as const, instructions }, meta);

export const choice = (instructions: string, criteria: Record<string, string>, meta?: object): Question =>
  withMeta({ type: "choice" as const, instructions, criteria }, meta);

export const score = (instructions: string, levels: string[], meta?: object): Question =>
  withMeta({ type: "score" as const, instructions, criteria: levels }, meta);

/** Neutral answer used when the decision service fails. */
export function fallbackAnswer(q: Question): Answer {
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  if (q.type === "choice") {
    const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
    return {
      type: "choice",
      choice: keys[0],
      probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])),
      confidence: 0,
    };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
  return {
    type: "score",
    score: (levels.length - 1) / 2,
    probabilities: Object.fromEntries(levels.map((_, i) => [String(i), 1 / levels.length])),
    confidence: 0,
  };
}

const fallbackAll = (questions: Record<string, Question>): Record<string, Answer> =>
  Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, fallbackAnswer(q)]));

export interface JevOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export class JevClient implements Decider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(o: JevOptions) {
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.baseUrl = (o.baseUrl ?? "https://openrouter.ai/api").replace(/\/+$/, "");
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.retries = o.retries ?? 2;
    this.backoffMs = o.backoffMs ?? 500;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  async decide(state: unknown, questions: Record<string, Question>, _purpose = ""): Promise<DecideResult> {
    const body = JSON.stringify({
      model: this.model,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([n, q]) => {
          const { meta: _meta, ...rest } = q;
          return [n, rest];
        }),
      ),
    });
    const url = `${this.baseUrl}/alpha/decisions`;
    let error = "";
    try {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        let retryable = true;
        try {
          const resp = await this.fetchFn(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          if (resp.status === 200) {
            const data = (await resp.json()) as { answers?: unknown; usage?: { cost?: number | null } };
            if (!data || typeof data.answers !== "object" || data.answers === null) {
              throw new Error("response missing answers");
            }
            const raw = data.answers as Record<string, Answer>;
            const answers: Record<string, Answer> = {};
            for (const [n, q] of Object.entries(questions)) {
              const a = raw[n];
              answers[n] = a && typeof a === "object" ? a : fallbackAnswer(q);
            }
            const cost = Number(data.usage?.cost ?? 0);
            return { answers, cost: Number.isFinite(cost) ? cost : 0, fallback: false };
          }
          error = `HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`;
          retryable = resp.status >= 500 || resp.status === 429;
        } catch (e) {
          error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
        if (!retryable) break;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { answers: fallbackAll(questions), cost: 0, fallback: true, error: error || "unknown error" };
  }
}

/** Test double: `rules(name, question) -> answer`. Records every call. */
export class FakeJev implements Decider {
  calls: { state: unknown; questions: Record<string, Question>; purpose?: string }[] = [];

  constructor(private readonly rules: (name: string, q: Question) => Answer) {}

  async decide(state: unknown, questions: Record<string, Question>, purpose?: string): Promise<DecideResult> {
    this.calls.push({ state, questions, purpose });
    const answers = Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, this.rules(n, q)]));
    return { answers, cost: 0, fallback: false };
  }
}
