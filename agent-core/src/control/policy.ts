import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export type Level = "off" | "suggest" | "auto";
export type Policy = { threshold: number; groups: Record<string, Level>; rateLimitPerMinute: number };

const LEVELS: readonly string[] = ["off", "suggest", "auto"];
const DEFAULT_POLICY: Policy = { threshold: 0.9, groups: {}, rateLimitPerMinute: 30 };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strictly validate a parsed policy document; returns null when anything is off. */
function validate(raw: unknown): Policy | null {
  if (!isPlainObject(raw)) return null;
  const { threshold, groups, rate_limit_per_minute: rate } = raw;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return null;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0) return null;
  const out: Record<string, Level> = Object.create(null);
  if (groups !== undefined && groups !== null) {
    if (!isPlainObject(groups)) return null;
    for (const [name, level] of Object.entries(groups)) {
      if (typeof level !== "string" || !LEVELS.includes(level)) return null;
      out[name] = level as Level;
    }
  }
  return { threshold, groups: out, rateLimitPerMinute: rate };
}

export class PolicyStore {
  private policy: Policy = { ...DEFAULT_POLICY, groups: {} };
  private watcher: fs.FSWatcher | null = null;

  constructor(private file: string, private log: (msg: string) => void) {
    this.reload();
  }

  current(): Policy {
    return this.policy;
  }

  /** Re-read the file. Any read, parse or validation failure keeps the last valid policy. */
  reload(): void {
    try {
      const parsed = validate(parse(fs.readFileSync(this.file, "utf8")));
      if (!parsed) {
        this.log(`policy: invalid content in ${this.file}; keeping last valid policy`);
        return;
      }
      this.policy = parsed;
    } catch (e) {
      this.log(`policy: cannot load ${this.file} (${(e as Error).message}); keeping last valid policy`);
    }
  }

  /** Watch the containing directory (survives editors that replace the file) and reload on change. */
  watch(): void {
    if (this.watcher) return;
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(path.dirname(path.resolve(this.file)), (_evt, name) => {
        if (name === null || name === base) this.reload();
      });
      this.watcher.on("error", (e) => this.log(`policy: watcher error ${(e as Error).message}`));
    } catch (e) {
      this.log(`policy: cannot watch ${this.file} (${(e as Error).message})`);
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
