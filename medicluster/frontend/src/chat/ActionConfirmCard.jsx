import React, { useState, useRef, useEffect } from 'react';
import { cliniqAction } from '../api/apiClient';
import { AlertCircle, CheckCircle2, XCircle, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { getActionDescription, computeNextActionState, ACTION_TOOL_LABELS } from './actionConfirmState';

export { getActionDescription, computeNextActionState };

export default function ActionConfirmCard({ action, onComplete }) {
  const initialStatus = action.status === 'SUCCEEDED'
    ? 'succeeded'
    : action.status === 'CANCELLED'
    ? 'cancelled'
    : action.status === 'PROPOSED' || !action.status
    ? 'pending'
    : String(action.status).toLowerCase();

  const [state, setState] = useState(initialStatus);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const controller = useRef(null);

  useEffect(() => {
    return () => controller.current?.abort();
  }, []);

  const handleDecision = async (decision) => {
    if (state !== 'pending') return;
    setState('working');
    setError('');
    controller.current = new AbortController();

    try {
      const data = await cliniqAction(action.id, decision, controller.current.signal);
      setResult(data.result);
      const nextState = computeNextActionState('pending', decision, data);
      setState(nextState);
      if (onComplete) onComplete(data);
    } catch (err) {
      if (err.code !== 'ERR_CANCELED') {
        setState('pending');
        setError(err.response?.data?.error || 'Action failed to execute. Verify system state before retrying.');
      }
    }
  };

  const toolTitle = ACTION_TOOL_LABELS[action.tool] || action.tool.replaceAll('_', ' ');
  const description = getActionDescription(action);

  return (
    <div
      className="rounded-2xl border-2 border-line bg-white p-4 space-y-3.5 text-sm shadow-sm transition-all"
      data-testid="action-confirm-card"
    >
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-amber-100 text-amber-900">
            <ShieldCheck size={18} />
          </span>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 block">
              Action Confirmation Required
            </span>
            <strong className="text-ink text-sm font-semibold">{toolTitle}</strong>
          </div>
        </div>

        <span
          className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
            state === 'pending'
              ? 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse'
              : state === 'working'
              ? 'bg-blue-50 text-blue-800 border-blue-300'
              : state === 'succeeded'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
              : 'bg-slate-100 text-slate-700 border-slate-300'
          }`}
          data-testid="action-status-badge"
        >
          {state === 'pending' ? 'Pending Confirmation' : state === 'working' ? 'Executing…' : state === 'succeeded' ? 'Confirmed & Done' : 'Cancelled'}
        </span>
      </div>

      <div className="p-3 rounded-xl bg-paper/80 border border-line space-y-2 text-xs">
        <div>
          <span className="text-slate-500 block text-[10px] uppercase font-semibold">What will happen:</span>
          <p className="font-medium text-ink mt-0.5 leading-relaxed" data-testid="action-description">
            {description}
          </p>
        </div>

        {action.selectedPatient && (
          <div className="pt-1.5 border-t border-line/60 flex items-center justify-between text-slate-600">
            <span>Patient:</span>
            <span className="font-semibold text-ink">{action.selectedPatient.name || action.selectedPatient.patientId} ({action.selectedPatient.patientId})</span>
          </div>
        )}

        {action.arguments && Object.keys(action.arguments).length > 0 && (
          <dl className="pt-1.5 border-t border-line/60 space-y-1">
            {Object.entries(action.arguments).map(([key, val]) => (
              <div key={key} className="flex justify-between items-center text-slate-600">
                <dt className="text-slate-500 font-mono">{key}:</dt>
                <dd className="font-medium text-ink break-all text-right">{Array.isArray(val) ? val.join(', ') : String(val)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {state === 'pending' && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500 italic">
            * Strict Safety Rule: MediCluster agents never auto-confirm destructive or clinical actions. Explicit clinician confirmation is required.
          </p>
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => handleDecision('approve')}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-xl bg-ink text-paper hover:bg-slate-800 font-semibold text-xs transition-colors shadow-sm"
              data-testid="confirm-action-button"
            >
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span>Confirm Action</span>
            </button>
            <button
              type="button"
              onClick={() => handleDecision('cancel')}
              className="py-2 px-4 rounded-xl border border-line bg-white hover:bg-slate-50 text-slate-700 font-medium text-xs transition-colors"
              data-testid="cancel-action-button"
            >
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {state === 'working' && (
        <div className="flex items-center gap-2 text-xs text-blue-700 font-medium py-1">
          <Clock size={14} className="animate-spin text-blue-600" />
          <span>Sending decision to agent backend…</span>
        </div>
      )}

      {state === 'succeeded' && (
        <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center gap-2">
          <CheckCircle2 size={15} className="text-emerald-700 shrink-0" />
          <span>Action executed successfully. Result verified by MediCluster system.</span>
        </div>
      )}

      {state === 'cancelled' && (
        <div className="p-2.5 rounded-xl bg-slate-100 border border-slate-200 text-slate-700 text-xs flex items-center gap-2">
          <XCircle size={15} className="text-slate-500 shrink-0" />
          <span>Action was cancelled by user. No state changes were applied.</span>
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-center gap-2">
          <AlertCircle size={15} className="text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
