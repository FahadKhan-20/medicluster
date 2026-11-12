import { useEffect, useState, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { getAgentHealth, getAgentAudits, controlAgent } from "../api/apiClient";
import { Page, Section, Tag } from "../components/ui";
import {
  ExternalLink,
  Power,
  Play,
  Square,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Activity,
  Layers,
  Cpu,
  Server,
  Filter,
} from "lucide-react";

const AGENT_CORE_URL = (import.meta.env.VITE_AGENT_CORE_URL || "http://localhost:8100").replace(/\/+$/, "");
const AUDIT_POLL_MS = 3_000;
const HEALTH_POLL_MS = 5_000;

function outcomeTone(outcome) {
  switch (String(outcome || "").toLowerCase()) {
    case "executed":
      return "normal";
    case "review":
      return "warning";
    case "blocked":
    case "failed":
      return "critical";
    case "skipped":
      return "noise";
    case "pending":
      return "medium";
    default:
      return "noise";
  }
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch {
    return String(iso);
  }
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function AgentPage() {
  const { user } = useAuth();
  const isAdmin = ["admin", "administrator"].includes(String(user?.role || "").toLowerCase());

  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState(null);

  const [audits, setAudits] = useState([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState(null);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);

  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  // Health fetch
  const fetchHealth = async () => {
    try {
      const data = await getAgentHealth();
      setHealth(data);
      setHealthError(null);
    } catch (err) {
      setHealth(null);
      setHealthError(err?.response?.data?.error || "Agent core service unreachable (503)");
    } finally {
      setHealthLoading(false);
    }
  };

  // Audits fetch
  const fetchAudits = async () => {
    try {
      const data = await getAgentAudits(50);
      const list = Array.isArray(data) ? data : data?.items || [];
      setAudits(list);
      setAuditError(null);
    } catch (err) {
      setAuditError(err?.response?.data?.error || "Failed to retrieve agent audits");
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    fetchHealth();
    fetchAudits();

    const healthInterval = setInterval(() => {
      if (alive) fetchHealth();
    }, HEALTH_POLL_MS);

    const auditInterval = setInterval(() => {
      if (alive) fetchAudits();
    }, AUDIT_POLL_MS);

    return () => {
      alive = false;
      clearInterval(healthInterval);
      clearInterval(auditInterval);
    };
  }, []);

  const handleControl = async (action) => {
    if (!isAdmin) {
      setActionError("Requires administrator role to stop or start the agent core.");
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      await controlAgent(action);
      await fetchHealth();
      await fetchAudits();
    } catch (err) {
      setActionError(err?.response?.data?.error || `Failed to ${action} agent`);
    } finally {
      setActionLoading(false);
    }
  };

  const isStopped = health?.stopped === true;
  const isHealthy = Boolean(health && !healthError);

  const filteredAudits = useMemo(() => {
    return audits.filter((item) => {
      const outcome = String(item.outcome || "").toLowerCase();
      if (outcomeFilter !== "all" && outcome !== outcomeFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const eventStr = JSON.stringify(item.event || "").toLowerCase();
        const reasonStr = String(item.reason || "").toLowerCase();
        const idStr = String(item._id || item.id || "").toLowerCase();
        return eventStr.includes(q) || reasonStr.includes(q) || idStr.includes(q) || outcome.includes(q);
      }
      return true;
    });
  }, [audits, outcomeFilter, searchQuery]);

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={`${AGENT_CORE_URL}/console`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] font-medium rounded-sm border border-line-strong hover:bg-sunken text-ink transition-colors"
      >
        <span>Open CliniQ Console</span>
        <ExternalLink size={13} className="text-slate-500" />
      </a>
      <a
        href={`${AGENT_CORE_URL}/codeblue`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] font-medium rounded-sm border border-line-strong hover:bg-sunken text-ink transition-colors"
      >
        <span>Open Code Blue War Room</span>
        <ExternalLink size={13} className="text-slate-500" />
      </a>
    </div>
  );

  return (
    <Page
      title="Agent Core"
      sub="Autonomous clinical safety, alerting & audit control"
      actions={actions}
    >
      <div className="flex flex-col gap-6">
        {/* Top Status & Controls Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Status & Kill Switch Card */}
          <Section
            title="Agent Operational State"
            className="lg:col-span-2"
            aside={
              <button
                onClick={() => {
                  fetchHealth();
                  fetchAudits();
                }}
                title="Refresh agent state"
                className="p-1 hover:bg-sunken rounded text-slate-500 hover:text-ink transition-colors"
              >
                <RefreshCw size={13} className={healthLoading ? "animate-spin" : ""} />
              </button>
            }
          >
            <div className="pt-4 flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded border border-line bg-paper">
                <div className="flex items-center gap-3">
                  <span className="relative flex h-3.5 w-3.5">
                    {!isHealthy ? (
                      <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-slate-400" />
                    ) : isStopped ? (
                      <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-amber-500" />
                    ) : (
                      <>
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500" />
                      </>
                    )}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[15px] text-ink">
                        {!isHealthy ? "Agent Core Unavailable" : isStopped ? "Agent Stopped" : "Agent Running"}
                      </span>
                      <Tag tone={!isHealthy ? "noise" : isStopped ? "warning" : "normal"}>
                        {!isHealthy ? "Offline" : isStopped ? "Halted" : "Active"}
                      </Tag>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono">
                      Endpoint: {AGENT_CORE_URL}
                    </p>
                  </div>
                </div>

                {/* Kill Switch Controls */}
                <div className="flex items-center gap-2">
                  {isStopped ? (
                    <button
                      type="button"
                      disabled={actionLoading || !isAdmin}
                      onClick={() => handleControl("start")}
                      className="inline-flex items-center gap-1.5 h-9 px-4 text-[13px] font-medium rounded-sm bg-emerald-700 hover:bg-emerald-800 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Play size={15} />
                      <span>{actionLoading ? "Starting…" : "Resume Agent"}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={actionLoading || !isAdmin || !isHealthy}
                      onClick={() => handleControl("stop")}
                      className="inline-flex items-center gap-1.5 h-9 px-4 text-[13px] font-medium rounded-sm bg-red-700 hover:bg-red-800 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Square size={14} className="fill-current" />
                      <span>{actionLoading ? "Stopping…" : "Stop Agent (Kill Switch)"}</span>
                    </button>
                  )}
                </div>
              </div>

              {!isAdmin && (
                <div className="text-[11.5px] text-slate-500 italic px-1">
                  * Note: Kill switch Stop and Resume operations require administrator credentials.
                </div>
              )}

              {actionError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center gap-2">
                  <AlertTriangle size={15} className="shrink-0 text-red-600" />
                  <span>{actionError}</span>
                </div>
              )}

              {healthError && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 flex items-center gap-2">
                  <AlertTriangle size={15} className="shrink-0 text-amber-600" />
                  <div>
                    <span className="font-semibold">Backend Proxy Notice:</span> {healthError}. Check that the agent-core process is active on port 8100.
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Service Health Card */}
          <Section title="Downstream Service Health">
            <div className="pt-4 flex flex-col gap-3">
              <div className="p-3 rounded border border-line bg-paper flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Server size={16} className="text-slate-500" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">Backend API</div>
                    <div className="text-[11px] text-slate-500 font-mono">PostgreSQL / Supabase</div>
                  </div>
                </div>
                <Tag tone={health?.services?.backend ? "normal" : "critical"}>
                  {health?.services?.backend ? "Healthy" : "Degraded"}
                </Tag>
              </div>

              <div className="p-3 rounded border border-line bg-paper flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Cpu size={16} className="text-slate-500" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">ML Engine</div>
                    <div className="text-[11px] text-slate-500 font-mono">Python / FastAPI</div>
                  </div>
                </div>
                <Tag tone={health?.services?.ml ? "normal" : "critical"}>
                  {health?.services?.ml ? "Healthy" : "Degraded"}
                </Tag>
              </div>

              <div className="p-3 rounded border border-line bg-paper flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Activity size={16} className="text-slate-500" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">Intelligence Worker</div>
                    <div className="text-[11px] text-slate-500 font-mono">ECG & Rhythm Analysis</div>
                  </div>
                </div>
                <Tag tone={health?.services?.intelligence ? "normal" : "critical"}>
                  {health?.services?.intelligence ? "Healthy" : "Degraded"}
                </Tag>
              </div>
            </div>
          </Section>
        </div>

        {/* Live Audit Feed Section */}
        <Section
          title="Live Agent Audit Stream"
          aside={
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-slate-500 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live 3s polling
              </span>
              <span className="text-xs text-slate-400">|</span>
              <span className="font-mono text-[11px] text-slate-500">
                {filteredAudits.length} events
              </span>
            </div>
          }
        >
          <div className="pt-4 flex flex-col gap-4">
            {/* Filter and Search Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {["all", "executed", "review", "blocked", "skipped", "failed", "pending"].map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setOutcomeFilter(o)}
                    className={`h-7 px-2.5 rounded text-[12px] font-mono tracking-tight transition-colors capitalize ${
                      outcomeFilter === o
                        ? "bg-ink text-paper font-medium"
                        : "bg-surface border border-line text-slate-600 hover:bg-sunken"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>

              <input
                type="text"
                placeholder="Filter audits (event, patient, id)…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 px-3 rounded border border-line text-xs bg-paper placeholder:text-slate-400 w-full sm:w-64"
              />
            </div>

            {auditError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center gap-2">
                <AlertTriangle size={15} className="shrink-0 text-red-600" />
                <span>{auditError}</span>
              </div>
            )}

            {/* Audit Table */}
            <div className="border border-line rounded bg-paper overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-sunken border-b border-line text-[11px] uppercase tracking-wider text-slate-500 font-mono">
                    <tr>
                      <th className="py-2.5 px-3 w-8"></th>
                      <th className="py-2.5 px-3">Timestamp</th>
                      <th className="py-2.5 px-3">Outcome</th>
                      <th className="py-2.5 px-3">Event / Source</th>
                      <th className="py-2.5 px-3">Patient</th>
                      <th className="py-2.5 px-3">Details / Reason</th>
                      <th className="py-2.5 px-3 text-right">Steps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {auditLoading && audits.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400 italic">
                          Loading audit stream…
                        </td>
                      </tr>
                    ) : filteredAudits.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400 italic">
                          No audit events matching current filter.
                        </td>
                      </tr>
                    ) : (
                      filteredAudits.map((item) => {
                        const id = item._id || item.id;
                        const isExpanded = expandedId === id;
                        const event = item.event || {};
                        const patientId = event.patientId || event.patient_id || item.patientId;
                        const eventName = event.kind || event.source || event.event || item.event_type || "Autonomous Audit";
                        const stepCount = Array.isArray(item.steps) ? item.steps.length : 0;

                        return (
                          <tr
                            key={id}
                            className={`hover:bg-slate-50/80 transition-colors group ${
                              isExpanded ? "bg-slate-50/50" : ""
                            }`}
                          >
                            <td className="py-3 px-3 align-top">
                              <button
                                type="button"
                                onClick={() => setExpandedId(isExpanded ? null : id)}
                                className="text-slate-400 hover:text-ink transition-colors"
                              >
                                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </td>

                            <td className="py-3 px-3 align-top whitespace-nowrap font-mono text-[11px] text-slate-600">
                              <div>{formatTime(item.startedAt || item.timestamp || item.at)}</div>
                              <div className="text-[10px] text-slate-400">{formatDate(item.startedAt || item.timestamp)}</div>
                            </td>

                            <td className="py-3 px-3 align-top whitespace-nowrap">
                              <Tag tone={outcomeTone(item.outcome)}>
                                {item.outcome || "pending"}
                              </Tag>
                            </td>

                            <td className="py-3 px-3 align-top font-medium text-ink">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[11.5px]">{eventName}</span>
                              </div>
                              <div className="font-mono text-[10px] text-slate-400 truncate max-w-[160px]">
                                {id}
                              </div>
                            </td>

                            <td className="py-3 px-3 align-top whitespace-nowrap">
                              {patientId ? (
                                <Link
                                  to={`/patient/${patientId}`}
                                  className="font-mono text-[11px] text-ink hover:underline font-semibold"
                                >
                                  {patientId}
                                </Link>
                              ) : (
                                <span className="text-slate-400 font-mono text-[11px]">System</span>
                              )}
                            </td>

                            <td className="py-3 px-3 align-top text-slate-600 max-w-[280px]">
                              <p className="line-clamp-2 leading-relaxed text-[11.5px]">
                                {item.reason || event.message || event.summary || event.note || "Autonomous agent evaluation"}
                              </p>
                              {isExpanded && (
                                <div className="mt-3 p-3 bg-sunken rounded border border-line text-[11px] font-mono overflow-x-auto space-y-2">
                                  <div>
                                    <span className="font-semibold text-slate-700">Raw Event:</span>
                                    <pre className="mt-1 text-[10.5px] text-slate-800 whitespace-pre-wrap">
                                      {JSON.stringify(event, null, 2)}
                                    </pre>
                                  </div>
                                  {stepCount > 0 && (
                                    <div>
                                      <span className="font-semibold text-slate-700">Step Trace:</span>
                                      <ul className="mt-1 space-y-1">
                                        {item.steps.map((st, sIdx) => (
                                          <li key={sIdx} className="text-[10.5px] border-l-2 border-line pl-2 py-0.5">
                                            <span className="font-semibold">{st.kind || "step"}:</span>{" "}
                                            <span>{JSON.stringify(st.data || {})}</span>{" "}
                                            <span className="text-slate-400">({formatTime(st.at)})</span>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>

                            <td className="py-3 px-3 align-top text-right font-mono text-[11px] text-slate-500 whitespace-nowrap">
                              {stepCount} {stepCount === 1 ? "step" : "steps"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Section>
      </div>
    </Page>
  );
}
