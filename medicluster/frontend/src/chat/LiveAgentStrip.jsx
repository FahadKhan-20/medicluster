import React, { useEffect, useState, useRef } from 'react';
import { getAgentAudits } from '../api/apiClient';
import {
  Activity,
  Bot,
  RotateCcw,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';

function outcomeTone(outcome) {
  switch (String(outcome || '').toLowerCase()) {
    case 'executed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'review':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'blocked':
    case 'failed':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return String(iso);
  }
}

export default function LiveAgentStrip({ onReplayAudit, className = '' }) {
  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pollTimer = useRef(null);

  const fetchAudits = async (isInitial = false) => {
    try {
      const data = await getAgentAudits(15);
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data?.audits)
        ? data.audits
        : [];
      setAudits(items);
      setError(null);
    } catch (err) {
      if (isInitial) {
        setError('Agent audit stream unavailable');
      }
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAudits(true);
    pollTimer.current = setInterval(() => {
      fetchAudits(false);
    }, 3000);

    return () => clearInterval(pollTimer.current);
  }, []);

  return (
    <aside
      className={`flex flex-col h-full bg-paper border-l border-line text-ink overflow-hidden ${className}`}
      data-testid="live-agent-strip"
      aria-label="Live Agent Audit Stream"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-line bg-surface/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800 shrink-0">
            <Activity size={15} />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs text-ink">Live Agent</span>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                3s Live
              </span>
            </div>
            <p className="text-[11px] text-slate-500">Autonomous decisions &amp; trace</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => fetchAudits(false)}
          className="p-1 rounded text-slate-400 hover:text-ink hover:bg-slate-100 transition-colors"
          title="Refresh audits"
          aria-label="Refresh audits"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Decision list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {loading && audits.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400 italic">
            Connecting to agent audit feed…
          </div>
        ) : error && audits.length === 0 ? (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={13} className="text-amber-600" />
              <span>Offline Feed</span>
            </div>
            <p className="text-[11px] text-amber-700 leading-relaxed">
              Waiting for agent-core service on :8100. Audit events will appear here in real time.
            </p>
          </div>
        ) : audits.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No recent autonomous decisions recorded.
          </div>
        ) : (
          audits.map((item) => {
            const id = item._id || item.id || `audit-${Math.random()}`;
            const event = item.event || {};
            const patientId = event.patientId || event.patient_id || item.patientId;
            const eventName = event.kind || event.source || event.event || item.event_type || 'Autonomous Action';
            const reason = item.reason || event.message || event.summary || event.note || 'Safety criteria verified by Jev consensus';
            const outcome = item.outcome || 'executed';

            return (
              <div
                key={id}
                onClick={() => onReplayAudit && onReplayAudit(item)}
                className="group p-3 rounded-xl border border-line bg-white hover:border-slate-400 hover:shadow-xs transition-all cursor-pointer space-y-2 text-left"
                data-testid="live-agent-audit-item"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-slate-500 font-medium">{formatTime(item.startedAt || item.timestamp || item.at)}</span>
                  <span className={`px-2 py-0.2 rounded-full font-semibold uppercase text-[10px] border ${outcomeTone(outcome)}`}>
                    {outcome}
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-xs text-ink truncate">{eventName}</span>
                    {patientId && (
                      <span className="font-mono text-[10.5px] text-slate-600 font-medium bg-slate-100 px-1.5 py-0.2 rounded">
                        {patientId}
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] text-slate-600 mt-1 line-clamp-2 leading-relaxed">
                    {reason}
                  </p>
                </div>

                <div className="pt-1 border-t border-line/60 flex items-center justify-between text-[11px] text-emerald-800 font-medium">
                  <span className="group-hover:underline flex items-center gap-1">
                    <RotateCcw size={11} />
                    <span>Replay in chat</span>
                  </span>
                  <ChevronRight size={13} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
