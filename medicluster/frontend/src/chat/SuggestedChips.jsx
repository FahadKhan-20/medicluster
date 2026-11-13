import React from 'react';
import { Ambulance, FileSearch, ShieldAlert, AlertTriangle, HeartPulse, Zap } from 'lucide-react';

export const SUGGESTED_PROMPTS = [
  {
    text: "Nearest ambulance to patient P001",
    label: "Nearest ambulance",
    icon: Ambulance,
    category: "dispatch",
  },
  {
    text: "Latest imaging findings for P001",
    label: "Imaging findings",
    icon: FileSearch,
    category: "imaging",
  },
  {
    text: "Why did the agent alert on P072?",
    label: "Why agent alerted",
    icon: ShieldAlert,
    category: "decision",
  },
  {
    text: "Any critical alerts?",
    label: "Critical alerts",
    icon: AlertTriangle,
    category: "alerts",
  },
  {
    text: "Sepsis risk for P003",
    label: "Sepsis risk",
    icon: HeartPulse,
    category: "sepsis",
  },
  {
    text: "Start Code Blue drill for DEMO-P001",
    label: "Code Blue drill",
    icon: Zap,
    category: "codeblue",
  },
];

export default function SuggestedChips({ onSelect, disabled = false, className = '', centered = false }) {
  return (
    <div className={className} data-testid="suggested-chips">
      <div className={`grid gap-2 ${centered ? 'grid-cols-2 sm:grid-cols-3 max-w-2xl mx-auto' : 'grid-cols-2 lg:grid-cols-3'}`}>
        {SUGGESTED_PROMPTS.map((prompt) => {
          const Icon = prompt.icon;
          return (
            <button
              key={prompt.text}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(prompt.text)}
              className="group flex items-start gap-2.5 p-3 rounded-2xl bg-white border border-[#e2e8db] hover:border-[#c9d2bf] hover:bg-[#f7f9f3] text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid={`suggested-chip-${prompt.category}`}
            >
              <span className="w-8 h-8 shrink-0 rounded-xl bg-[#e7ecdf] grid place-items-center text-[#17251d] group-hover:bg-[#17251d] group-hover:text-[#fbfaf7] transition-colors">
                <Icon size={15} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-[#17251d] leading-tight">{prompt.label}</span>
                <span className="block mt-0.5 text-[11.5px] text-slate-500 leading-snug">{prompt.text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
