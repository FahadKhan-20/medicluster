import http from "node:http";

export interface ContainerInspect {
  id: string;
  name: string;
  status: string; // e.g. "running", "exited", "dead", "paused", "restarting", "created"
  running: boolean;
  exitCode?: number;
  health?: string; // e.g. "healthy", "unhealthy", "starting"
  raw?: unknown;
}

export interface DockerResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface DockerClient {
  inspect(container: string): Promise<ContainerInspect | null>;
  restart(container: string, timeoutSec?: number): Promise<DockerResult>;
}

export type HttpRequestFn = (options: http.RequestOptions) => Promise<{ status: number; data: string }>;

/** Built-in http client over unix socket */
function defaultHttpOverSocket(options: http.RequestOptions): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, data: body });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Docker request timed out"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

export class DockerHttpController implements DockerClient {
  private socketPath: string;
  private timeoutMs: number;
  private requestFn: HttpRequestFn;

  constructor(opts?: { socketPath?: string; timeoutMs?: number; requestFn?: HttpRequestFn }) {
    this.socketPath = opts?.socketPath ?? "/var/run/docker.sock";
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
    this.requestFn = opts?.requestFn ?? defaultHttpOverSocket;
  }

  async inspect(container: string): Promise<ContainerInspect | null> {
    try {
      const res = await this.requestFn({
        socketPath: this.socketPath,
        path: `/containers/${encodeURIComponent(container)}/json`,
        method: "GET",
        headers: {
          Host: "docker",
          Accept: "application/json",
        },
        timeout: this.timeoutMs,
      });

      if (res.status === 404) {
        return null;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Docker inspect failed with status ${res.status}: ${res.data}`);
      }

      const data = JSON.parse(res.data);
      const state = data.State ?? {};
      return {
        id: data.Id ?? "",
        name: (data.Name ?? container).replace(/^\//, ""),
        status: state.Status ?? "unknown",
        running: Boolean(state.Running),
        exitCode: typeof state.ExitCode === "number" ? state.ExitCode : undefined,
        health: state.Health?.Status,
        raw: data,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("status 404")) {
        return null;
      }
      throw err;
    }
  }

  async restart(container: string, timeoutSec = 10): Promise<DockerResult> {
    try {
      const res = await this.requestFn({
        socketPath: this.socketPath,
        path: `/containers/${encodeURIComponent(container)}/restart?t=${timeoutSec}`,
        method: "POST",
        headers: {
          Host: "docker",
          Accept: "application/json",
        },
        timeout: this.timeoutMs,
      });

      if (res.status === 204 || res.status === 200) {
        return { ok: true, status: res.status };
      }
      if (res.status === 404) {
        return { ok: false, status: 404, error: `container not found: ${container}` };
      }
      return { ok: false, status: res.status, error: res.data || `Docker returned HTTP ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, error: message };
    }
  }
}

/** Test double for DockerClient */
export class FakeDockerClient implements DockerClient {
  public containers = new Map<string, Partial<ContainerInspect>>();
  public restarts: { container: string; timeoutSec?: number; at: number }[] = [];
  public restartFails = new Set<string>();

  constructor(initial?: Record<string, Partial<ContainerInspect>>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.containers.set(k, v);
      }
    }
  }

  setContainer(name: string, state: Partial<ContainerInspect>): void {
    this.containers.set(name, state);
  }

  failRestart(name: string): void {
    this.restartFails.add(name);
  }

  succeedRestart(name: string): void {
    this.restartFails.delete(name);
  }

  async inspect(container: string): Promise<ContainerInspect | null> {
    const c = this.containers.get(container);
    if (!c) return null;
    return {
      id: c.id ?? `id-${container}`,
      name: container,
      status: c.status ?? "running",
      running: c.running ?? (c.status === "running"),
      exitCode: c.exitCode,
      health: c.health,
      raw: c.raw,
    };
  }

  async restart(container: string, timeoutSec?: number): Promise<DockerResult> {
    this.restarts.push({ container, timeoutSec, at: Date.now() });
    if (this.restartFails.has(container)) {
      return { ok: false, status: 500, error: `failed to restart ${container}` };
    }
    const c = this.containers.get(container);
    if (!c) {
      return { ok: false, status: 404, error: `container not found: ${container}` };
    }
    this.containers.set(container, {
      ...c,
      status: "running",
      running: true,
      health: "healthy",
    });
    return { ok: true, status: 204 };
  }
}
