import type { AuditOutcome } from "../audit/audit.js";

export interface BuilderTask {
  title: string;
  description: string;
}

export interface TestResultSummary {
  passed: boolean;
  exitCode: number;
  logTail: string;
}

export interface BuilderResult {
  auditId: string;
  branch: string;
  commit: string;
  outcome: AuditOutcome;
  reason?: string;
  tests: {
    agentCore: TestResultSummary;
    backend: TestResultSummary;
    allPassed: boolean;
  };
  diffStat: string;
  logTail: string;
  decision?: {
    readyToMerge: boolean;
    score: number;
    fallback: boolean;
    cost?: number;
    error?: string;
  };
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  runCommand(fullCommand: string, options?: ProcessRunOptions): Promise<ProcessResult>;
}
