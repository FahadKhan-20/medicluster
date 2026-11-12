import http from "node:http";

export const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate container names against ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$
 * and refuse any container whose name contains "agent-core".
 */
export function isValidContainerName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (!CONTAINER_NAME_REGEX.test(name)) return false;
  if (name.includes("agent-core")) return false;
  return true;
}

export interface ContainerInspect {
  id: string;
  name: string;
  status: string; // e.g. "running", "exited", "dead", "paused", "restarting", "created"
  running: boolean;
  exitCode?: number;
  health?: string; // e.g. "healthy", "unhealthy", "starting"
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

/** Built-in http client over socket or TCP */
function defaultHttpTransport(options: http.RequestOptions): Promise<{ status: number; data: string }> {
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

export interface DockerControllerOptions {
  dockerHost?: string; // e.g. tcp://docker-proxy:2375, http://localhost:2375, unix:///var/run/docker.sock
  socketPath?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  requestFn?: HttpRequestFn;
}

export class DockerHttpController implements DockerClient {
  private socketPath?: string;
  private host?: string;
  private port?: number;
  private timeoutMs: number;
  private requestFn: HttpRequestFn;

  constructor(opts?: DockerControllerOptions) {
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
    this.requestFn = opts?.requestFn ?? defaultHttpTransport;

    const rawHost = opts?.dockerHost ?? process.env.DOCKER_HOST;
    if (opts?.host) {
      this.host = opts.host;
      this.port = opts.port ?? 2375;
    } else if (rawHost) {
      if (rawHost.startsWith("tcp://") || rawHost.startsWith("http://")) {
        const urlStr = rawHost.startsWith("tcp://") ? `http://${rawHost.slice(6)}` : rawHost;
        const u = new URL(urlStr);
        this.host = u.hostname;
        this.port = u.port ? Number(u.port) : 2375;
      } else if (rawHost.startsWith("unix://")) {
        this.socketPath = rawHost.slice(7);
      } else {
        this.socketPath = rawHost;
      }
    } else {
      this.socketPath = opts?.socketPath ?? "/var/run/docker.sock";
    }
  }

  private buildRequestOptions(path: string, method: "GET" | "POST"): http.RequestOptions {
    if (this.host) {
      return {
        host: this.host,
        port: this.port ?? 2375,
        path,
        method,
        headers: {
          Host: `${this.host}:${this.port ?? 2375}`,
          Accept: "application/json",
        },
        timeout: this.timeoutMs,
      };
    }
    return {
      socketPath: this.socketPath ?? "/var/run/docker.sock",
      path,
      method,
      headers: {
        Host: "docker",
        Accept: "application/json",
      },
      timeout: this.timeoutMs,
    };
  }

  async inspect(container: string): Promise<ContainerInspect | null> {
    if (!isValidContainerName(container)) {
      throw new Error(`invalid container name: ${container}`);
    }

    try {
      const res = await this.requestFn(
        this.buildRequestOptions(`/containers/${encodeURIComponent(container)}/json`, "GET"),
      );

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
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("status 404")) {
        return null;
      }
      throw err;
    }
  }

  async restart(container: string, timeoutSec = 10): Promise<DockerResult> {
    if (!isValidContainerName(container)) {
      return { ok: false, status: 400, error: `invalid container name: ${container}` };
    }

    try {
      const res = await this.requestFn(
        this.buildRequestOptions(`/containers/${encodeURIComponent(container)}/restart?t=${timeoutSec}`, "POST"),
      );

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
    if (!isValidContainerName(container)) {
      throw new Error(`invalid container name: ${container}`);
    }
    const c = this.containers.get(container);
    if (!c) return null;
    return {
      id: c.id ?? `id-${container}`,
      name: container,
      status: c.status ?? "running",
      running: c.running ?? (c.status === "running"),
      exitCode: c.exitCode,
      health: c.health,
    };
  }

  async restart(container: string, timeoutSec?: number): Promise<DockerResult> {
    if (!isValidContainerName(container)) {
      return { ok: false, status: 400, error: `invalid container name: ${container}` };
    }
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
