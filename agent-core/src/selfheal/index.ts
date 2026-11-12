import type { HealthPoller } from "../events/health.js";
import type { Event } from "../events/events.js";
import type { trackInFlight } from "../lifecycle.js";
import { DockerHttpController, type DockerClient } from "./docker.js";
import { SelfhealLoop, type SelfhealDeps } from "./loop.js";

export * from "./docker.js";
export * from "./tracker.js";
export * from "./loop.js";

export interface RegisterSelfhealOptions extends Omit<SelfhealDeps, "docker"> {
  docker?: DockerClient;
  work?: ReturnType<typeof trackInFlight>;
}

/**
 * Register self-heal with HealthPoller so that service.down events trigger selfheal.handle.
 */
export function registerSelfheal(health: HealthPoller, options: RegisterSelfhealOptions): SelfhealLoop {
  const docker = options.docker ?? new DockerHttpController();
  const loop = new SelfhealLoop({ ...options, docker });

  const handleDown = options.work
    ? options.work.wrap((e: Event) => loop.handle(e).then(() => undefined))
    : (e: Event) => {
        void loop.handle(e).catch((err) => console.error("[selfheal] error handling event:", err));
      };

  const originalStart = health.start.bind(health);
  health.start = async (onEvent: (e: Event) => Promise<void> | void): Promise<void> => {
    return originalStart(async (e: Event) => {
      if (e.type === "service.down") {
        void handleDown(e);
      }
      return onEvent(e);
    });
  };

  return loop;
}
