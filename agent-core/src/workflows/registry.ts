import { execSync } from "node:child_process";

export type WorkflowStatus = "active" | "degraded" | "paused" | "off" | "not configured";

export interface WorkflowDescriptor {
  id: string;
  name: string;
  description: string;
  group: string;
  prefixes: string[];
  deps?: string[];
  registered?: boolean;
  checkConfig?: () => string | null;
  notConfiguredReason?: string;
}

export interface AgentWorkflowResponse {
  id: string;
  name: string;
  description: string;
  group: string;
  policyLevel: "off" | "suggest" | "auto";
  policy: "off" | "suggest" | "auto";
  registered: boolean;
  deps: Record<string, boolean>;
  dependentServices: Record<string, boolean>;
  lastEventAt: string | null;
  lastOutcome: string | null;
  counts: Record<string, number>;
  counts24h: Record<string, number>;
  status: WorkflowStatus;
  reason: string | null;
}

export function isBuilderCliAvailable(): boolean {
  if (process.env.BUILDER_CLI_MISSING === "1") return false;
  const cmd = process.env.BUILDER_CMD || "agy";
  const binary = cmd.trim().split(/\s+/)[0];
  try {
    execSync(`command -v ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function deriveWorkflowStatus(
  wf: WorkflowDescriptor,
  opts: {
    policyLevel?: string;
    isStopped?: boolean;
    health?: { isUp(name: string): boolean };
  }
): { status: WorkflowStatus; reason: string | null } {
  if (wf.registered === false) {
    return {
      status: "not configured",
      reason: wf.notConfiguredReason || "Workflow not registered",
    };
  }

  if (wf.checkConfig) {
    const cfgErr = wf.checkConfig();
    if (cfgErr) {
      return { status: "not configured", reason: cfgErr };
    }
  }

  if (wf.notConfiguredReason) {
    return { status: "not configured", reason: wf.notConfiguredReason };
  }

  const policyLevel = opts.policyLevel ?? "auto";
  if (policyLevel === "off") {
    return {
      status: "off",
      reason: "Policy disabled (group off in policy.yaml)",
    };
  }

  if (opts.isStopped) {
    return {
      status: "paused",
      reason: "Kill switch activated",
    };
  }

  if (wf.deps && wf.deps.length > 0 && opts.health) {
    for (const dep of wf.deps) {
      if (!opts.health.isUp(dep)) {
        return {
          status: "degraded",
          reason: `Dependent service (${dep}) is down`,
        };
      }
    }
  }

  return { status: "active", reason: null };
}

export function computeWorkflowMetrics(
  wf: WorkflowDescriptor,
  audits: any[],
  nowMs = Date.now()
): {
  lastEventAt: string | null;
  lastOutcome: string | null;
  counts24h: Record<string, number>;
} {
  const oneDayAgo = nowMs - 24 * 60 * 60 * 1000;
  let lastEventAt: string | null = null;
  let lastOutcome: string | null = null;
  let lastEventTime = -Infinity;
  const counts: Record<string, number> = {
    executed: 0,
    review: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
  };

  for (const a of audits) {
    if (!a) continue;
    const eventType = (a.event?.type ?? a.type ?? a.eventType ?? "") as string;
    const matches = wf.prefixes.some((prefix) => {
      if (prefix.endsWith(".")) {
        return eventType.startsWith(prefix) || eventType === prefix.slice(0, -1);
      }
      return eventType.startsWith(prefix);
    });
    if (!matches) continue;

    const timestamp = a.finishedAt || a.startedAt || a.createdAt;
    const eventTime = timestamp ? new Date(timestamp).getTime() : NaN;
    if (!Number.isNaN(eventTime)) {
      if (eventTime > lastEventTime) {
        lastEventTime = eventTime;
        lastEventAt = timestamp;
        lastOutcome = a.outcome ?? null;
      }
      if (eventTime >= oneDayAgo) {
        const outcome = String(a.outcome || "pending").toLowerCase();
        counts[outcome] = (counts[outcome] || 0) + 1;
      }
    } else if (!lastEventAt && timestamp) {
      lastEventAt = timestamp;
      lastOutcome = a.outcome ?? null;
      const outcome = String(a.outcome || "pending").toLowerCase();
      counts[outcome] = (counts[outcome] || 0) + 1;
    }
  }

  return { lastEventAt, lastOutcome, counts24h: counts };
}

export function getDefaultWorkflows(): WorkflowDescriptor[] {
  return [
    {
      id: "imaging",
      name: "Imaging Scan Loop",
      description: "Autonomous radiological scan processing and triage",
      group: "imaging",
      prefixes: ["scan."],
      deps: ["backend", "ml"],
      registered: true,
    },
    {
      id: "alerts",
      name: "Clinical Alerts",
      description: "Clinician escalation, alert dispatch & notification",
      group: "alerts",
      prefixes: ["alert.", "alerts."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "reminders",
      name: "Medication Reminders",
      description: "Prescription adherence and patient reminder delivery",
      group: "reminders",
      prefixes: ["reminder."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "radar",
      name: "Deterioration Radar",
      description: "Continuous vital signs tracking & early clinical deterioration detection",
      group: "radar",
      prefixes: ["radar.", "vitals."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "sepsis",
      name: "Sepsis Watch",
      description: "qSOFA scoring, sepsis screening & automated bedside alerts",
      group: "sepsis",
      prefixes: ["sepsis."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "ecg",
      name: "ECG Interpretation",
      description: "Automated ECG rhythm analysis, arrhythmia alerts & clinician escalation",
      group: "ecg",
      prefixes: ["ecg."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "codeblue",
      name: "Code Blue War Room",
      description: "ACLS protocol guidance, real-time resuscitation orchestrator",
      group: "codeblue",
      prefixes: ["codeblue."],
      deps: ["backend"],
      registered: true,
    },
    {
      id: "dispatch",
      name: "Ambulance Dispatch",
      description: "Emergency CAD incident intake, triage & paramedic crew assignment",
      group: "dispatch",
      prefixes: ["incident."],
      deps: ["dispatch"],
      registered: true,
      checkConfig: () =>
        process.env.DISPATCH_URL
          ? null
          : "Missing DISPATCH_URL environment variable. Set DISPATCH_URL=http://dispatch-api:3001 to enable.",
    },
    {
      id: "selfheal",
      name: "Self-Heal Engine",
      description: "Container recovery, health degradation monitoring & automatic restart",
      group: "selfheal",
      prefixes: ["service.", "container."],
      deps: ["backend"],
      registered: true,
      checkConfig: () =>
        process.env.DOCKER_HOST
          ? null
          : "Missing DOCKER_HOST environment variable. Set DOCKER_HOST=tcp://docker-proxy:2375 to enable.",
    },
    {
      id: "builder",
      name: "Spec Builder",
      description: "Autonomous task implementation, git worktree isolation and test verification",
      group: "builder",
      prefixes: ["builder."],
      deps: [],
      registered: true,
      checkConfig: () =>
        isBuilderCliAvailable()
          ? null
          : "Missing CLI executable. Install agy CLI or set BUILDER_CMD to enable.",
    },
    {
      id: "pharmacy",
      name: "Pharmacy Ops",
      description: "Automated stock monitoring, stuck order escalation & refill outreach",
      group: "pharmacy",
      prefixes: ["pharmacy."],
      deps: ["backend"],
      registered: true,
    },
  ];
}
