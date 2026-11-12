import jwt from "jsonwebtoken";

export type Config = {
  supabaseUrl: string;
  supabaseKey: string;
  backendUrl: string;
  agentJwtSecret: string;
  adminKey: string;
  omnirouteUrl: string;
  omnirouteKey: string;
  agentModel: string;
  openrouterKey: string;
  jevModel: string;
  mlUrl: string;
  intelUrl: string;
  port: number;
  policyPath: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "BACKEND_URL",
  "AGENT_JWT_SECRET",
  "AGENT_ADMIN_KEY",
  "OPENROUTER_API_KEY",
] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const secret = env.AGENT_JWT_SECRET as string;
  if (secret.length < 32) {
    throw new ConfigError("AGENT_JWT_SECRET must be at least 32 characters");
  }
  const port = Number(env.AGENT_PORT ?? 8100);
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigError(`AGENT_PORT must be a positive integer, got "${env.AGENT_PORT}"`);
  }
  return {
    supabaseUrl: env.SUPABASE_URL as string,
    supabaseKey: env.SUPABASE_SECRET_KEY as string,
    backendUrl: env.BACKEND_URL as string,
    agentJwtSecret: secret,
    adminKey: env.AGENT_ADMIN_KEY as string,
    omnirouteUrl: env.OMNIROUTE_URL || "http://localhost:20128",
    omnirouteKey: env.OMNIROUTE_API_KEY ?? "",
    agentModel: env.AGENT_MODEL || "agy/gemini-3.8-flash-medium",
    openrouterKey: env.OPENROUTER_API_KEY as string,
    jevModel: env.JEV_MODEL || "typesafe/jev-1.13",
    mlUrl: env.ML_URL || "http://ml-engine:8000",
    intelUrl: env.INTEL_URL || "http://intelligence-engine:8090",
    port,
    policyPath: env.POLICY_PATH || "policy.yaml",
  };
}

export function signAgentToken(secret: string): string {
  return jwt.sign({ sub: "agent-core", kind: "agent" }, secret, { expiresIn: "12h" });
}
