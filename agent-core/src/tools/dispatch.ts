// Dispatch tools and client: interface to ambulance-dispatch API (port 3001).
// All actions validate their arguments and retry only transient/5xx errors.

export type DispatchResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; retryable: false };

export interface Ambulance {
  id: string;
  call_sign?: string;
  callSign?: string;
  status: string;
  latitude: number;
  longitude: number;
  unit_type?: string;
  type?: string;
  distance?: number;
  distanceKm?: number;
  etaMinutes?: number;
  assigned_incident_id?: string | null;
  [key: string]: unknown;
}

export interface Hospital {
  id: string;
  name?: string;
  latitude: number;
  longitude: number;
  available_beds: number;
  total_beds?: number;
  score?: number;
  distance?: number;
  [key: string]: unknown;
}

export interface Incident {
  id: string;
  status: string;
  incident_type?: string;
  severity?: string;
  location_lat: number;
  location_lng: number;
  location_address?: string;
  caller_name?: string;
  caller_phone?: string;
  patients_count?: number;
  description?: string;
  is_sos?: boolean;
  assigned_ambulance_id?: string | null;
  assigned_hospital_id?: string | null;
  dispatched_at?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface AssignAmbulanceArgs {
  incident_id: string;
  ambulance_id: string;
  hospital_id: string;
  notes?: string;
}

export interface DispatchClientOptions {
  baseUrl?: string;
  /** Called on every request so the bearer token is always freshly signed. */
  token?: () => string;
  fetch?: typeof globalThis.fetch;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export class DispatchClient {
  readonly baseUrl: string;
  private readonly token?: () => string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(o: DispatchClientOptions = {}) {
    this.baseUrl = (o.baseUrl || process.env.DISPATCH_URL || "http://dispatch-api:3001").replace(/\/+$/, "");
    this.token = o.token;
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.retries = o.retries ?? 3;
    this.backoffMs = o.backoffMs ?? 500;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<DispatchResult<T>> {
    const url = `${this.baseUrl}${path}`;
    let status = 0;
    let error = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const headers: Record<string, string> = {};
        if (this.token) headers["Authorization"] = `Bearer ${this.token()}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const resp = await this.fetchFn(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = resp.status;
        if (resp.ok) {
          const text = await resp.text().catch(() => "");
          let data: unknown = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          return { ok: true, status, data: data as T };
        }
        error = `HTTP ${status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`;
        if (status < 500) return { ok: false, status, error, retryable: false };
      } catch (e) {
        status = 0;
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
    }
    return { ok: false, status, error: error || "unknown error", retryable: false };
  }

  getIncident(id: string): Promise<DispatchResult<Incident>> {
    return this.call<Incident>("GET", `/api/incidents/${encodeURIComponent(id)}`);
  }

  getAvailableAmbulances(coords?: { lat?: number; lng?: number; radius?: number }): Promise<DispatchResult<{ ambulances: Ambulance[] }>> {
    const params = new URLSearchParams();
    if (coords?.lat !== undefined) params.set("lat", String(coords.lat));
    if (coords?.lng !== undefined) params.set("lng", String(coords.lng));
    if (coords?.radius !== undefined) params.set("radius", String(coords.radius));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.call<{ ambulances: Ambulance[] }>("GET", `/api/ambulances/available${qs}`);
  }

  getRecommendations(incidentId: string): Promise<DispatchResult<{ ambulances: Ambulance[]; hospitals: Hospital[] }>> {
    return this.call<{ ambulances: Ambulance[]; hospitals: Hospital[] }>("GET", `/api/assignments/recommendations/${encodeURIComponent(incidentId)}`);
  }

  getScoredHospitals(incidentId: string): Promise<DispatchResult<{ hospitals: Hospital[] }>> {
    return this.call<{ hospitals: Hospital[] }>("GET", `/api/hospitals/scored/${encodeURIComponent(incidentId)}`);
  }

  assignAmbulance(args: AssignAmbulanceArgs): Promise<DispatchResult<Incident>> {
    return this.call<Incident>("POST", "/api/assignments", {
      incidentId: args.incident_id,
      ambulanceId: args.ambulance_id,
      hospitalId: args.hospital_id,
      notes: args.notes,
    });
  }
}

export type PropSchema = {
  type: "string" | "object" | "number";
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
};

export type DispatchToolSchema = {
  type: "object";
  properties: Record<string, PropSchema>;
  required: string[];
  additionalProperties: false;
};

export type DispatchTool = {
  name: string;
  group: "dispatch";
  action: "assign";
  schema: DispatchToolSchema;
  run(args: Record<string, unknown>, client: Pick<DispatchClient, "call">): Promise<DispatchResult>;
};

const ID_PROP: PropSchema = { type: "string", minLength: 1, maxLength: 128 };
const NOTES_PROP: PropSchema = { type: "string", maxLength: 4000 };

export function validateDispatchArgs(tool: DispatchTool, args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["args must be an object"];
  const a = args as Record<string, unknown>;
  const { properties, required } = tool.schema;
  const errors: string[] = [];
  for (const k of Object.keys(a)) if (!Object.hasOwn(properties, k)) errors.push(`unexpected argument: ${k}`);
  for (const k of required) if (a[k] === undefined) errors.push(`missing required argument: ${k}`);
  for (const [k, p] of Object.entries(properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (p.type === "string") {
      if (typeof v !== "string") {
        errors.push(`${k} must be a string`);
        continue;
      }
      if (p.minLength !== undefined && v.length < p.minLength) errors.push(`${k} must be at least ${p.minLength} characters`);
      if (p.maxLength !== undefined && v.length > p.maxLength) errors.push(`${k} must be at most ${p.maxLength} characters`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) errors.push(`${k} has invalid format`);
      if (p.enum && !p.enum.includes(v)) errors.push(`${k} must be one of: ${p.enum.join(", ")}`);
    }
  }
  return errors;
}

export const DISPATCH_ASSIGN_TOOL: DispatchTool = {
  name: "dispatch.assign",
  group: "dispatch",
  action: "assign",
  schema: {
    type: "object",
    properties: {
      incident_id: ID_PROP,
      ambulance_id: ID_PROP,
      hospital_id: ID_PROP,
      notes: NOTES_PROP,
    },
    required: ["incident_id", "ambulance_id", "hospital_id"],
    additionalProperties: false,
  },
  async run(args, client) {
    const errors = validateDispatchArgs(DISPATCH_ASSIGN_TOOL, args);
    if (errors.length) {
      return { ok: false, status: 0, error: `invalid arguments: ${errors.join("; ")}`, retryable: false };
    }
    return client.call("POST", "/api/assignments", {
      incidentId: args.incident_id,
      ambulanceId: args.ambulance_id,
      hospitalId: args.hospital_id,
      notes: typeof args.notes === "string" ? args.notes : "",
    });
  },
};
