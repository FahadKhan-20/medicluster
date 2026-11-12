/**
 * Small client adapters for intelligence endpoints:
 * - Arrest Rhythm classification: POST /api/intelligence/rhythm/classify
 * - 12-lead ECG analysis (parallel par/ecg contract): POST /api/intelligence/ecg/analyze
 */

export interface RhythmClassifyResult {
  probabilities: Record<string, number>;
  top: string;
  model: string;
}

export interface EcgAnalyzeResult {
  probabilities: {
    NORM: number;
    MI: number;
    STTC: number;
    CD: number;
    HYP: number;
    [k: string]: number;
  };
  top: string;
  model: string;
}

export interface ClientOptions {
  baseUrl: string;
  token?: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}

export class RhythmClient {
  private readonly baseUrl: string;
  private readonly token?: () => string | Promise<string>;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async classify(lead: number[], fs = 250): Promise<RhythmClassifyResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers["authorization"] = `Bearer ${await this.token()}`;
    }

    const res = await this.fetchFn(`${this.baseUrl}/api/intelligence/rhythm/classify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ lead, fs }),
    });

    if (!res.ok) {
      throw new Error(`Rhythm classify failed with status ${res.status}`);
    }

    return (await res.json()) as RhythmClassifyResult;
  }
}

export class EcgClient {
  private readonly baseUrl: string;
  private readonly token?: () => string | Promise<string>;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async analyze(signal: number[][]): Promise<EcgAnalyzeResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers["authorization"] = `Bearer ${await this.token()}`;
    }

    const res = await this.fetchFn(`${this.baseUrl}/api/intelligence/ecg/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signal }),
    });

    if (!res.ok) {
      throw new Error(`ECG analyze failed with status ${res.status}`);
    }

    return (await res.json()) as EcgAnalyzeResult;
  }
}
