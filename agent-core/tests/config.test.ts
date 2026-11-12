import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { loadConfig, ConfigError, signAgentToken } from "../src/config.js";

const SECRET = "x".repeat(32);
const base = {
  SUPABASE_URL: "http://sb",
  SUPABASE_SECRET_KEY: "sk",
  BACKEND_URL: "http://backend",
  AGENT_JWT_SECRET: SECRET,
  AGENT_ADMIN_KEY: "admin",
  OPENROUTER_API_KEY: "or",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.agentModel).toBe("agy/gemini-3.8-flash-medium");
    expect(c.jevModel).toBe("typesafe/jev-1.13");
    expect(c.port).toBe(8100);
    expect(c.omnirouteUrl).toBe("http://localhost:20128");
    expect(c.policyPath).toBe("policy.yaml");
    expect(c.mlUrl).toBe("http://ml-engine:8000");
    expect(c.intelUrl).toBe("http://intelligence-engine:8090");
    expect(c.agentJwtSecret).toBe(SECRET);
  });

  it("reports every missing required key in one error", () => {
    let err: unknown;
    try { loadConfig({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    for (const k of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "BACKEND_URL", "AGENT_JWT_SECRET", "AGENT_ADMIN_KEY", "OPENROUTER_API_KEY"]) {
      expect(msg).toContain(k);
    }
  });

  it("rejects AGENT_JWT_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...base, AGENT_JWT_SECRET: "short" })).toThrow(ConfigError);
  });

  it("signAgentToken output verifies with the secret and has sub \"agent-core\", kind \"agent\"", () => {
    const payload = jwt.verify(signAgentToken(SECRET), SECRET) as jwt.JwtPayload;
    expect(payload.sub).toBe("agent-core");
    expect(payload.kind).toBe("agent");
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
  });
});
