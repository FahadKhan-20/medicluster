import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export * from "./render.js";

let cachedHtml: string | null = null;

export function getConsoleHtml(): string {
  if (cachedHtml && process.env.NODE_ENV === "production") {
    return cachedHtml;
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDir, "index.html"),
    join(currentDir, "../../src/console/index.html"),
    join(process.cwd(), "src/console/index.html"),
    join(process.cwd(), "agent-core/src/console/index.html"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedHtml = readFileSync(candidate, "utf-8");
      return cachedHtml;
    }
  }

  throw new Error("Unable to locate console/index.html");
}
