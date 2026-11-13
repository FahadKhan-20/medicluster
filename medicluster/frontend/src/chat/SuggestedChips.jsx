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
    <div className={`space-y-2 ${className}`} data-testid="suggested-chips">
      <div className={`flex flex-wrap gap-1.5 ${centered ? 'justify-center gap-2' : ''}`}>
        {SUGGESTED_PROMPTS.map((prompt) => {
          const Icon = prompt.icon;
          return (
            <button
              key={prompt.text}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(prompt.text)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-paper border border-line hover:border-slate-400 hover:bg-white text-ink transition-all text-left shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid={`suggested-chip-${prompt.category}`}
            >
              <Icon size={12} className="text-slate-500 shrink-0" />
              <span>{prompt.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
