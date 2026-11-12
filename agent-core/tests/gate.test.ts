import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyStore } from "../src/control/policy.js";
import { Gate, GateInput } from "../src/control/gate.js";

const VALID = "threshold: 0.9\ngroups:\n  imaging: auto\n  alerts: suggest\nrate_limit_per_minute: 30\n";
let dir: string, file: string, logs: string[], t: number;
const store = () => new PolicyStore(file, (m) => logs.push(m));
const gate = (s = store()) => new Gate(s, () => t);
const input = (o: Partial<GateInput> = {}): GateInput => ({
  group: "imaging", action: "analyze", actionProb: 0.95, actNow: 0.95,
  fallback: false, stopped: false, key: "m:new:analyze", done: false, ...o,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  file = path.join(dir, "policy.yaml");
  fs.writeFileSync(file, VALID);
  logs = []; t = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("gate", () => {
  it("executes a confident, allowed action", () => {
    expect(gate().check(input())).toEqual({ verdict: "execute", reason: "ok" });
  });
  it("stopped blocks", () => {
    expect(gate().check(input({ stopped: true }))).toEqual({ verdict: "blocked", reason: "stopped" });
  });
  it("done key blocks", () => {
    expect(gate().check(input({ done: true }))).toEqual({ verdict: "blocked", reason: "duplicate" });
  });
  it("action containing delete blocks", () => {
    expect(gate().check(input({ action: "Delete_media" }))).toEqual({ verdict: "blocked", reason: "no_delete" });
  });
  it("off and absent groups block", () => {
    fs.writeFileSync(file, "threshold: 0.9\ngroups:\n  imaging: off\nrate_limit_per_minute: 30\n");
    const g = gate();
    expect(g.check(input()).reason).toBe("group_off");
    expect(g.check(input({ group: "unknown" })).reason).toBe("group_off");
    expect(g.check(input({ group: "__proto__" })).reason).toBe("group_off");
    expect(g.check(input({ group: "toString" })).reason).toBe("group_off");
  });
  it("rate limit", () => {
    const g = gate();
    for (let i = 0; i < 30; i++) g.record("imaging");
    expect(g.check(input())).toEqual({ verdict: "blocked", reason: "rate_limited" });
    expect(g.check(input({ group: "alerts" })).reason).not.toBe("rate_limited");
    t += 61_000;
    expect(g.check(input()).verdict).toBe("execute");
  });
  it("treatment forced to review", () => {
    expect(gate().check(input({ action: "prescribe", actionProb: 0.99, actNow: 0.99 })))
      .toEqual({ verdict: "review", reason: "treatment_requires_doctor" });
  });
  it("fallback never executes", () => {
    expect(gate().check(input({ fallback: true, actionProb: 0.99, actNow: 0.99 })))
      .toEqual({ verdict: "review", reason: "jev_fallback" });
  });
  it("suggest level", () => {
    expect(gate().check(input({ group: "alerts" }))).toEqual({ verdict: "review", reason: "suggest_level" });
  });
  it("threshold", () => {
    const g = gate();
    expect(g.check(input({ actionProb: 0.9, actNow: 0.9 })).verdict).toBe("execute");
    expect(g.check(input({ actionProb: 0.89 }))).toEqual({ verdict: "review", reason: "low_confidence" });
    expect(g.check(input({ actNow: 0.89 }))).toEqual({ verdict: "review", reason: "low_confidence" });
    expect(g.check(input({ actionProb: NaN })).reason).toBe("low_confidence");
  });
});

describe("PolicyStore", () => {
  it("defaults when no valid policy ever loaded", () => {
    fs.writeFileSync(file, "groups: [");
    expect(store().current()).toEqual({ threshold: 0.9, groups: {}, rateLimitPerMinute: 30 });
  });
  it("missing file defaults", () => {
    fs.rmSync(file);
    expect(new PolicyStore(file, (m) => logs.push(m)).current().groups).toEqual({});
    expect(logs.length).toBe(1);
  });
  it("invalid policy keeps last valid", () => {
    const s = store();
    const before = structuredClone(s.current());
    expect(before).toEqual({ threshold: 0.9, groups: { imaging: "auto", alerts: "suggest" }, rateLimitPerMinute: 30 });
    fs.writeFileSync(file, "groups: [");
    s.reload();
    expect(s.current()).toEqual(before);
    expect(logs.length).toBe(1);
  });
  it.each([
    ["threshold: 0\nrate_limit_per_minute: 30\n"],
    ["threshold: 1.5\nrate_limit_per_minute: 30\n"],
    ["threshold: .nan\nrate_limit_per_minute: 30\n"],
    ["threshold: .inf\nrate_limit_per_minute: 30\n"],
    ["threshold: '0.9'\nrate_limit_per_minute: 30\n"],
    ["threshold: 0.5\nrate_limit_per_minute: 0\n"],
    ["threshold: 0.5\nrate_limit_per_minute: 2.5\n"],
    ["threshold: 0.5\nrate_limit_per_minute: 5\ngroups:\n  imaging: yolo\n"],
    ["threshold: 0.5\nrate_limit_per_minute: 5\ngroups: [a]\n"],
    ["- just a list\n"],
    [""],
  ])("rejects %j", (content) => {
    const s = store();
    const before = structuredClone(s.current());
    fs.writeFileSync(file, content);
    s.reload();
    expect(s.current()).toEqual(before);
  });
  it("applies a valid change on reload", () => {
    const s = store();
    fs.writeFileSync(file, "threshold: 0.95\ngroups:\n  imaging: off\nrate_limit_per_minute: 5\n");
    s.reload();
    expect(s.current()).toEqual({ threshold: 0.95, groups: { imaging: "off" }, rateLimitPerMinute: 5 });
  });
});
