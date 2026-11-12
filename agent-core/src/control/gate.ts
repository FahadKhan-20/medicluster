import { PolicyStore } from "./policy.js";

export const TREATMENT_ACTIONS = ["prescribe", "dose", "diagnose"];

export type GateInput = {
  group: string;
  action: string;
  actionProb: number;
  actNow: number;
  fallback: boolean;
  stopped: boolean;
  key: string;
  done: boolean;
};
export type GateResult = { verdict: "execute" | "review" | "blocked"; reason: string };

const WINDOW_MS = 60_000;

/** Pure decision gate. Every rule fails closed: anything unexpected never yields "execute". */
export class Gate {
  private hits = new Map<string, number[]>();

  constructor(private policy: PolicyStore, private now: () => number = () => Date.now()) {}

  private recent(group: string): number[] {
    const t = this.now();
    const list = (this.hits.get(group) ?? []).filter((x) => t - x < WINDOW_MS);
    this.hits.set(group, list);
    return list;
  }

  /** Count one executed action toward the group's rate limit. */
  record(group: string): void {
    this.recent(group).push(this.now());
  }

  check(i: GateInput): GateResult {
    const p = this.policy.current();
    const action = String(i.action).toLowerCase();
    if (i.stopped !== false) return { verdict: "blocked", reason: "stopped" };
    if (i.done !== false) return { verdict: "blocked", reason: "duplicate" };
    if (action.includes("delete")) return { verdict: "blocked", reason: "no_delete" };
    const level = Object.hasOwn(p.groups, i.group) ? p.groups[i.group] : "off";
    if (level !== "auto" && level !== "suggest") return { verdict: "blocked", reason: "group_off" };
    if (this.recent(i.group).length >= p.rateLimitPerMinute) return { verdict: "blocked", reason: "rate_limited" };
    if (TREATMENT_ACTIONS.some((a) => action.includes(a))) return { verdict: "review", reason: "treatment_requires_doctor" };
    if (i.fallback !== false) return { verdict: "review", reason: "jev_fallback" };
    if (level === "suggest") return { verdict: "review", reason: "suggest_level" };
    if (!(i.actionProb >= p.threshold && i.actNow >= p.threshold)) return { verdict: "review", reason: "low_confidence" };
    return { verdict: "execute", reason: "ok" };
  }
}
