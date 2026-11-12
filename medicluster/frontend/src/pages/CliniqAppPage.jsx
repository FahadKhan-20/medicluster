import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ChatProvider, useCliniqChat } from '../chat/ChatContext';
import ChatView from '../chat/ChatView';
import LiveAgentStrip from '../chat/LiveAgentStrip';
import {
  Bot,
  Activity,
  ArrowLeft,
  Sparkles,
  ShieldCheck,
  PanelRightClose,
  PanelRightOpen,
  Layers,
} from 'lucide-react';

function CliniqAppContent() {
  const { user } = useAuth();
  const { injectReplayMessage } = useCliniqChat();
  const [showLiveStrip, setShowLiveStrip] = useState(true);

  const role = user?.role || (user?.id?.startsWith('patient') ? 'patient' : 'clinician');
  const returnHref = role === 'patient' ? '/app' : '/dashboard';

  return (
    <div className="flex flex-col h-screen w-screen bg-paper text-ink overflow-hidden" data-testid="cliniq-standalone-app">
      {/* Top Application Bar */}
      <header className="h-14 border-b border-line bg-white/90 backdrop-blur-sm px-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-3">
          <Link
            to={returnHref}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-ink px-2.5 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            title="Return to workspace"
          >
            <ArrowLeft size={15} />
            <span className="hidden sm:inline">Workspace</span>
          </Link>

          <div className="h-4 w-px bg-line" />

          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl bg-ink text-paper grid place-items-center font-bold text-sm shadow-xs">
              Q
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm tracking-tight text-ink">CliniQ</span>
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Universal Chat
                </span>
              </div>
              <p className="text-[11px] text-slate-500 leading-none">
                One conversational interface for MediCluster &amp; Dispatch
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* User role & identity pill */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-xs text-slate-700 border border-slate-200">
            <ShieldCheck size={13} className="text-emerald-600" />
            <span className="font-medium capitalize">{role}:</span>
            <span className="font-semibold text-ink truncate max-w-[140px]">{user?.name || user?.email || 'Authenticated'}</span>
          </div>

          {/* Toggle Live Agent Sidebar */}
          <button
            type="button"
            onClick={() => setShowLiveStrip((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              showLiveStrip
                ? 'bg-slate-100 text-ink border-slate-300'
                : 'bg-white text-slate-600 border-line hover:bg-slate-50'
            }`}
            title={showLiveStrip ? 'Hide Live Agent stream' : 'Show Live Agent stream'}
            aria-label="Toggle live agent stream"
            data-testid="toggle-live-agent-strip"
          >
            <Activity size={14} className={showLiveStrip ? 'text-emerald-600' : 'text-slate-400'} />
            <span className="hidden md:inline">Live Agent</span>
          </button>
        </div>
      </header>

      {/* Main Workspace: Chat & Live Agent Split */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <main className="flex-1 flex flex-col min-w-0 bg-paper">
          <ChatView
            isPanel={false}
            className="flex-1 h-full"
            showSuggestedChips={true}
          />
        </main>

        {showLiveStrip && (
          <div className="w-80 lg:w-96 shrink-0 h-full border-l border-line shadow-xs">
            <LiveAgentStrip
              onReplayAudit={(audit) => injectReplayMessage(audit)}
              className="h-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function CliniqAppPage() {
  return (
    <ChatProvider>
      <CliniqAppContent />
    </ChatProvider>
  );
}
