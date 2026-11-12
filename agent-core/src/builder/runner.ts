import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

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

export class NodeProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ProcessResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const append = (str: string, isStdErr: boolean) => {
        if (isStdErr) {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += str;
        } else {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += str;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), false));
      child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), true));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
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
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const append = (str: string, isStdErr: boolean) => {
        if (isStdErr) {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += str;
        } else {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += str;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), false));
      child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8"), true));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
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
    this.handlers.push({ pattern, handler: fn });
    return this;
  }

  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    const full = `${command} ${args.join(" ")}`.trim();
    return this.dispatch(command, args, options, full);
  }

  async runCommand(fullCommand: string, options?: ProcessRunOptions): Promise<ProcessResult> {
    const [cmd = "", ...args] = splitArgs(fullCommand);
    this.calls.push({ command: cmd, args, options, fullCommand });
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
