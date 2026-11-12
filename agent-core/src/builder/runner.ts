import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB
const BASE_ENV_VARS = ["PATH", "HOME", "LANG", "TERM"];

/** Extract the tail of output text bounded by lines and characters. */
export function tail(text: string, maxLines = 50, maxChars = 4000): string {
  if (!text) return "";
  const lines = text.split("\n");
  const slicedLines = lines.slice(-maxLines).join("\n");
  if (slicedLines.length <= maxChars) return slicedLines;
  return slicedLines.slice(-maxChars);
}

/** Split a shell command line into argv array (handling quotes). */
export function splitArgs(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (inQuotes) {
      if (char === inQuotes) {
        inQuotes = null;
      } else if (char === "\\" && inQuotes === '"' && i + 1 < command.length) {
        i++;
        current += command[i];
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      inQuotes = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Build scrubbed environment containing only PATH, HOME, LANG, TERM and allowlist, denying all secrets. */
export function scrubEnv(
  parentEnv: Record<string, string | undefined> = process.env,
  allowlistStr: string = process.env.BUILDER_ENV_ALLOW ?? ""
): Record<string, string> {
  const allowlist = allowlistStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isForbidden = (key: string): boolean => {
    const k = key.toUpperCase();
    if (k.includes("ADMIN")) return true;
    if (k.startsWith("SUPABASE")) return true;
    if (k.includes("AGENT_JWT") || k.includes("SECRET")) return true;
    if (k.includes("OPENROUTER") || k.includes("OMNIROUTE")) return true;
    if (k.endsWith("_KEY") || k.startsWith("KEY_") || k === "KEY") return true;
    return false;
  };

  const allowedKeys = new Set([...BASE_ENV_VARS, ...allowlist]);
  const scrubbed: Record<string, string> = {};

  for (const key of allowedKeys) {
    if (isForbidden(key)) continue;
    const val = parentEnv[key];
    if (val !== undefined) {
      scrubbed[key] = val;
    }
  }

  return scrubbed;
}

/** Collect all values longer than 12 chars from parent env for redaction. */
export function collectSecrets(
  parentEnv: Record<string, string | undefined> = process.env,
  minLength = 13
): string[] {
  const secrets = new Set<string>();
  for (const val of Object.values(parentEnv)) {
    if (typeof val === "string" && val.length >= minLength) {
      secrets.add(val);
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Redact all occurrences of secret values from text. */
export function redactSecrets(text: string, secrets: string[]): string {
  if (!text) return "";
  let res = text;
  for (const secret of secrets) {
    if (!secret) continue;
    res = res.replaceAll(secret, "[REDACTED]");
  }
  return res;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ProcessResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let pollTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      const append = (str: string, isStdErr: boolean) => {
        if (isStdErr) {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += str;
        } else {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += str;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), false));
      child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), true));

      if (options?.isStopped) {
        const pollIntervalMs = options.pollIntervalMs ?? 5000;
        pollTimer = setInterval(async () => {
          try {
            if (await options.isStopped!()) {
              if (settled) return;
              settled = true;
              cleanup();
              child.kill("SIGTERM");
              setTimeout(() => {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // ignore
                }
              }, 2000).unref();
              resolve({
                exitCode: 143,
                stdout,
                stderr: stderr + "\n[process terminated by kill switch (SIGTERM)]",
                durationMs: Date.now() - start,
              });
            }
          } catch {
            // ignore check error
          }
        }, pollIntervalMs);
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3000).unref();
        resolve({
          exitCode: 124, // standard timeout exit code
          stdout,
          stderr: stderr + `\n[process timed out after ${timeoutMs}ms]`,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[spawn error: ${err.message}]`,
          durationMs: Date.now() - start,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  async runCommand(fullCommand: string, options?: ProcessRunOptions): Promise<ProcessResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ProcessResult>((resolve) => {
      const child = spawn(fullCommand, {
        shell: true,
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let pollTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      const append = (str: string, isStdErr: boolean) => {
        if (isStdErr) {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += str;
        } else {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += str;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), false));
      child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), true));

      if (options?.isStopped) {
        const pollIntervalMs = options.pollIntervalMs ?? 5000;
        pollTimer = setInterval(async () => {
          try {
            if (await options.isStopped!()) {
              if (settled) return;
              settled = true;
              cleanup();
              child.kill("SIGTERM");
              setTimeout(() => {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // ignore
                }
              }, 2000).unref();
              resolve({
                exitCode: 143,
                stdout,
                stderr: stderr + "\n[command terminated by kill switch (SIGTERM)]",
                durationMs: Date.now() - start,
              });
            }
          } catch {
            // ignore check error
          }
        }, pollIntervalMs);
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3000).unref();
        resolve({
          exitCode: 124,
          stdout,
          stderr: stderr + `\n[command timed out after ${timeoutMs}ms]`,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[spawn error: ${err.message}]`,
          durationMs: Date.now() - start,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}

type CommandHandler = (
  cmd: string,
  args: string[],
  options?: ProcessRunOptions
) => Partial<ProcessResult> | Promise<Partial<ProcessResult>>;

export interface RecordedCall {
  command: string;
  args: string[];
  options?: ProcessRunOptions;
  fullCommand?: string;
}

export class FakeProcessRunner implements ProcessRunner {
  calls: RecordedCall[] = [];
  private handlers: { pattern: string | RegExp; handler: CommandHandler }[] = [];
  defaultResult: Partial<ProcessResult> = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };

  onCommand(
    pattern: string | RegExp,
    handler: Partial<ProcessResult> | CommandHandler
  ): this {
    const fn: CommandHandler =
      typeof handler === "function" ? handler : () => handler;
    this.handlers.unshift({ pattern, handler: fn });
    return this;
  }

  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    if (options?.isStopped && await options.isStopped()) {
      return {
        exitCode: 143,
        stdout: "",
        stderr: "[process terminated by kill switch (SIGTERM)]",
        durationMs: 1,
      };
    }
    const full = `${command} ${args.join(" ")}`.trim();
    return this.dispatch(command, args, options, full);
  }

  async runCommand(fullCommand: string, options?: ProcessRunOptions): Promise<ProcessResult> {
    const [cmd = "", ...args] = splitArgs(fullCommand);
    this.calls.push({ command: cmd, args, options, fullCommand });
    if (options?.isStopped && await options.isStopped()) {
      return {
        exitCode: 143,
        stdout: "",
        stderr: "[command terminated by kill switch (SIGTERM)]",
        durationMs: 1,
      };
    }
    return this.dispatch(cmd, args, options, fullCommand);
  }

  private async dispatch(
    command: string,
    args: string[],
    options: ProcessRunOptions | undefined,
    full: string
  ): Promise<ProcessResult> {
    for (const { pattern, handler } of this.handlers) {
      const matches =
        typeof pattern === "string"
          ? full.includes(pattern) || command === pattern
          : pattern.test(full);
      if (matches) {
        const res = await handler(command, args, options);
        return {
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
          durationMs: res.durationMs ?? 1,
        };
      }
    }
    return {
      exitCode: this.defaultResult.exitCode ?? 0,
      stdout: this.defaultResult.stdout ?? "",
      stderr: this.defaultResult.stderr ?? "",
      durationMs: this.defaultResult.durationMs ?? 1,
    };
  }
}
