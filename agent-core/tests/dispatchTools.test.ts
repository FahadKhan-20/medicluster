import { describe, it, expect, vi } from "vitest";
import {
  DispatchClient,
  DISPATCH_ASSIGN_TOOL,
  validateDispatchArgs,
} from "../src/tools/dispatch.js";

describe("DispatchClient", () => {
  it("defaults baseUrl to http://dispatch-api:3001 or env", () => {
    const client = new DispatchClient();
    expect(client.baseUrl).toBe("http://dispatch-api:3001");

    const custom = new DispatchClient({ baseUrl: "http://localhost:3001/" });
    expect(custom.baseUrl).toBe("http://localhost:3001");
  });

  it("attaches freshly signed bearer token to calls", async () => {
    let sentAuth = "";
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>)?.["Authorization"] || "";
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });

    const client = new DispatchClient({
      token: () => "agent-token-xyz",
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const res = await client.getIncident("INC-100");
    expect(res.ok).toBe(true);
    expect(sentAuth).toBe("Bearer agent-token-xyz");
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://dispatch-api:3001/api/incidents/INC-100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retries 5xx errors with backoff but fails immediately on 4xx", async () => {
    let attempts = 0;
    const failing500 = vi.fn(async () => {
      attempts++;
      return new Response(JSON.stringify({ error: "server error" }), { status: 503 });
    });

    const client = new DispatchClient({
      fetch: failing500 as unknown as typeof fetch,
      retries: 2,
      backoffMs: 1,
    });

    const res500 = await client.getIncident("INC-1");
    expect(res500.ok).toBe(false);
    expect(attempts).toBe(3); // 1 initial + 2 retries

    attempts = 0;
    const failing404 = vi.fn(async () => {
      attempts++;
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const client404 = new DispatchClient({
      fetch: failing404 as unknown as typeof fetch,
      retries: 2,
      backoffMs: 1,
    });

    const res404 = await client404.getIncident("INC-1");
    expect(res404.ok).toBe(false);
    expect(attempts).toBe(1); // 4xx does not retry
  });

  it("supports getAvailableAmbulances with coordinates", async () => {
    let requestedUrl = "";
    const fakeFetch = vi.fn(async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ ambulances: [{ id: "A-1", status: "AVAILABLE" }] }), { status: 200 });
    });

    const client = new DispatchClient({ fetch: fakeFetch as unknown as typeof fetch });
    const res = await client.getAvailableAmbulances({ lat: 12.97, lng: 77.59, radius: 10 });

    expect(res.ok).toBe(true);
    expect(requestedUrl).toBe("http://dispatch-api:3001/api/ambulances/available?lat=12.97&lng=77.59&radius=10");
  });

  it("supports getRecommendations and getScoredHospitals", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes("/recommendations/")) {
        return new Response(JSON.stringify({ ambulances: [], hospitals: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ hospitals: [{ id: "H-1", score: 95 }] }), { status: 200 });
    });

    const client = new DispatchClient({ fetch: fakeFetch as unknown as typeof fetch });
    const rec = await client.getRecommendations("INC-2");
    expect(rec.ok).toBe(true);

    const scored = await client.getScoredHospitals("INC-2");
    expect(scored.ok).toBe(true);
  });

  it("supports assignAmbulance", async () => {
    let sentBody: any;
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "INC-1", status: "ASSIGNED" }), { status: 201 });
    });

    const client = new DispatchClient({ fetch: fakeFetch as unknown as typeof fetch });
    const res = await client.assignAmbulance({
      incident_id: "INC-1",
      ambulance_id: "AMB-1",
      hospital_id: "H-1",
      notes: "Test notes",
    });

    expect(res.ok).toBe(true);
    expect(sentBody).toEqual({
      incidentId: "INC-1",
      ambulanceId: "AMB-1",
      hospitalId: "H-1",
      notes: "Test notes",
    });
  });
});

describe("DISPATCH_ASSIGN_TOOL", () => {
  it("validates required arguments strictly", () => {
    const valid = { incident_id: "INC-1", ambulance_id: "AMB-1", hospital_id: "H-1", notes: "Note" };
    expect(validateDispatchArgs(DISPATCH_ASSIGN_TOOL, valid)).toEqual([]);

    expect(validateDispatchArgs(DISPATCH_ASSIGN_TOOL, null)).toContain("args must be an object");

    const missing = { incident_id: "INC-1" };
    const errs = validateDispatchArgs(DISPATCH_ASSIGN_TOOL, missing);
    expect(errs).toContain("missing required argument: ambulance_id");
    expect(errs).toContain("missing required argument: hospital_id");

    const unexpected = { ...valid, extra: "malicious" };
    expect(validateDispatchArgs(DISPATCH_ASSIGN_TOOL, unexpected)).toContain("unexpected argument: extra");
  });

  it("rejects invalid types and oversized notes", () => {
    const invalidTypes = { incident_id: 123, ambulance_id: "AMB-1", hospital_id: "H-1" };
    expect(validateDispatchArgs(DISPATCH_ASSIGN_TOOL, invalidTypes)).toContain("incident_id must be a string");

    const oversized = {
      incident_id: "INC-1",
      ambulance_id: "AMB-1",
      hospital_id: "H-1",
      notes: "x".repeat(4001),
    };
    expect(validateDispatchArgs(DISPATCH_ASSIGN_TOOL, oversized)).toContain("notes must be at most 4000 characters");
  });

  it("run method rejects invalid arguments without calling client", async () => {
    const callSpy = vi.fn();
    const result = await DISPATCH_ASSIGN_TOOL.run({ invalid: true }, { call: callSpy });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("run method calls client when arguments are valid", async () => {
    const callSpy = vi.fn(async () => ({ ok: true as const, status: 201, data: {} }));
    const result = await DISPATCH_ASSIGN_TOOL.run(
      { incident_id: "INC-1", ambulance_id: "AMB-1", hospital_id: "H-1", notes: "ok" },
      { call: callSpy },
    );
    expect(result.ok).toBe(true);
    expect(callSpy).toHaveBeenCalledWith("POST", "/api/assignments", {
      incidentId: "INC-1",
      ambulanceId: "AMB-1",
      hospitalId: "H-1",
      notes: "ok",
    });
  });
});
