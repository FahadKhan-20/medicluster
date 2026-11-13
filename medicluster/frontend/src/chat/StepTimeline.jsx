import React, { useState } from 'react';
import {
  ChevronDown,
  CheckCircle2,
  Clock,
  Sparkles,
  AlertTriangle,
  Bot,
  Activity,
  Layers,
  ShieldCheck,
} from 'lucide-react';
import { buildExecutionTrace } from './stepTimelineState';

export { buildExecutionTrace };

export default function StepTimeline({ agentData, steps: providedSteps, isPending = false, defaultOpen = true }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const steps = providedSteps || buildExecutionTrace(agentData, isPending);

  if (!steps || steps.length === 0) return null;

  return (
    <div
      className="rounded-xl border border-line bg-white overflow-hidden text-xs"
      data-testid="execution-timeline"
    >
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-paper transition-colors text-left font-medium text-slate-700"
        aria-expanded={isOpen}
        data-testid="timeline-toggle"
      >
        <div className="flex items-center gap-2">
          <span className="p-1 rounded-md bg-emerald-100 text-emerald-800">
            <Activity size={13} />
          </span>
          <span className="font-medium text-ink text-[13px]">
            Agent Execution Trace ({steps.length} steps)
          </span>
          {!isOpen && (() => {
            const tools = steps.map((st) => String(st.title || st.label || '')).filter((t) => /calling tool/i.test(t)).map((t) => t.replace(/calling tool\s*/i, ''));
            return tools.length ? <span className="text-slate-400 font-normal truncate max-w-[260px]">· {tools.join(', ')}</span> : null;
          })()}
        </div>
        <ChevronDown
          size={14}
          className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="p-3 border-t border-line space-y-2.5 bg-white/60">
          <ol className="relative border-l border-slate-200 ml-2 space-y-2.5" data-testid="timeline-steps">
            {steps.map((st, idx) => {
              const isCompleted = st.status === 'completed';
              const isError = st.status === 'error';

              return (
                <li key={idx} className="ml-3.5" data-testid={`timeline-step-${idx}`}>
                  <span
                    className={`absolute -left-1.5 mt-0.5 w-3 h-3 rounded-full border-2 border-white ${
                      isError
                        ? 'bg-red-500'
                        : isCompleted
                        ? 'bg-emerald-600'
                        : 'bg-amber-500 animate-pulse'
                    }`}
                  />
                  <div className="flex flex-col">
                    <span
                      className={`font-medium text-[12px] ${
                        isError ? 'text-red-700' : isCompleted ? 'text-ink' : 'text-amber-800'
                      }`}
                    >
                      {st.label}
                    </span>
                    {st.detail && (
                      <span className="text-[11px] text-slate-500 mt-0.5">{st.detail}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
