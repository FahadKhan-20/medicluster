import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ChatProvider, useCliniqChat } from '../chat/ChatContext';
import ChatView from '../chat/ChatView';
import LiveAgentStrip from '../chat/LiveAgentStrip';
import {
  Activity,
  ArrowLeft,
  ShieldCheck,
  SquarePen,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
} from 'lucide-react';

// Same quick asks as the agent console's Chat branches, so both surfaces feel like one product.
const QUICK_ASKS = [
  { label: 'Nearest ambulance', ask: 'Nearest ambulance to patient P001' },
  { label: 'Imaging findings', ask: 'Latest imaging findings for P001' },
  { label: 'Why did the agent alert?', ask: 'Why did the agent alert on P072?' },
  { label: 'Critical alerts', ask: 'Any critical alerts?' },
  { label: 'Sepsis risk', ask: 'Sepsis risk for P003' },
  { label: 'Code Blue drill', ask: 'Start Code Blue drill for DEMO-P001' },
];

function Branch({ label, onClick, last, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative block w-full text-left h-9 ml-3.5 pl-3 pr-2 rounded-md text-[14px] transition-colors ${
        active ? 'bg-[#e2e9d9] text-ink font-semibold' : 'text-ink hover:bg-[#e7ecdf]'
      }`}
      style={{ width: 'calc(100% - 14px)' }}
    >
      <span
        aria-hidden="true"
        className="absolute -left-3.5 top-0 h-1/2 w-2.5 border-l-[1.5px] border-b-[1.5px] rounded-bl-[7px]"
        style={{ borderColor: last ? '#c9d2bf' : '#9aa694' }}
      />
      <span className="block truncate">{label}</span>
    </button>
  );
}

function Sidebar({ onAsk, onNew, active, returnHref, user, role }) {
  const [open, setOpen] = useState(true);
  return (
    <aside className="w-64 shrink-0 h-full flex flex-col bg-[#f3f5ee] border-r border-line" data-testid="cliniq-sidebar">
      <div className="h-14 px-4 flex items-center gap-2 shrink-0">
        <span className="w-7 h-7 rounded-lg bg-ink text-paper grid place-items-center font-bold text-[13px]">Q</span>
        <span className="font-semibold text-[16px] tracking-tight text-ink">CliniQ</span>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={onNew}
          className="w-full h-10 flex items-center gap-2.5 px-3 rounded-xl bg-white border border-line text-[14px] font-medium text-ink hover:border-slate-400 transition-colors"
          data-testid="cliniq-new-chat"
        >
          <SquarePen size={16} /> New chat
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pt-4" aria-label="Quick asks">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full h-10 flex items-center gap-1.5 px-2 rounded-lg hover:bg-[#e7ecdf] text-ink"
          aria-expanded={open}
        >
          <span aria-hidden="true" className="grid grid-cols-2 gap-[3px] mr-1.5">
            {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className="w-[3px] h-[3px] rounded-full bg-slate-400" />)}
          </span>
          <span className="font-bold text-[14.5px]">Quick asks</span>
          <span className="ml-auto text-[12.5px] font-semibold text-slate-500">{QUICK_ASKS.length}</span>
          <ChevronDown size={15} className={`text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        {open && (
          <div className="mb-2 ml-[15px] space-y-0.5">
            {QUICK_ASKS.map((q, i) => (
              <Branch key={q.label} label={q.label} last={i === QUICK_ASKS.length - 1} active={active === q.label} onClick={() => onAsk(q)} />
            ))}
          </div>
        )}
      </nav>

      <div className="p-3 border-t border-line space-y-2 shrink-0">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-line text-xs text-slate-700">
          <ShieldCheck size={14} className="text-emerald-700 shrink-0" />
          <span className="capitalize font-medium">{role}</span>
          <span className="font-semibold text-ink truncate">{user?.name || user?.email || 'Signed in'}</span>
        </div>
        <Link to={returnHref} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] text-slate-600 hover:text-ink hover:bg-[#e7ecdf]">
          <ArrowLeft size={14} /> Back to workspace
        </Link>
      </div>
    </aside>
  );
}

function CliniqAppContent() {
  const { user } = useAuth();
  const { injectReplayMessage, handleChatSubmit, reset } = useCliniqChat();
  // Inside the agent console's Chat tab: chat only. Detect the frame itself, because a login redirect can drop ?embed=1.
  const embed = (() => {
    if (new URLSearchParams(window.location.search).get('embed') === '1') return true;
    try { return window.self !== window.top; } catch { return true; }
  })();
  // In the console the left column already exists, so the chat starts with the Live Agent panel closed.
  const [showLiveStrip, setShowLiveStrip] = useState(!embed);
  const [showSidebar, setShowSidebar] = useState(true);
  const [active, setActive] = useState(null);

  const role = user?.role || (user?.id?.startsWith('patient') ? 'patient' : 'clinician');
  const returnHref = role === 'patient' ? '/app' : '/dashboard';

  const ask = (q) => {
    setActive(q.label);
    reset();
    setTimeout(() => handleChatSubmit(q.ask), 0);
  };
  const newChat = () => {
    setActive(null);
    reset();
  };

  const liveToggle = (
    <button
      type="button"
      onClick={() => setShowLiveStrip((prev) => !prev)}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-medium border transition-colors ${
        showLiveStrip ? 'bg-[#e2e9d9] text-ink border-[#cfd9c4]' : 'bg-white text-slate-600 border-line hover:border-slate-400'
      }`}
      title={showLiveStrip ? 'Hide Live Agent stream' : 'Show Live Agent stream'}
      aria-label="Toggle live agent stream"
      data-testid="toggle-live-agent-strip"
    >
      <Activity size={14} className={showLiveStrip ? 'text-emerald-700' : 'text-slate-400'} />
      Live Agent
    </button>
  );

  return (
    <div
      className="flex h-screen w-screen bg-paper text-ink overflow-hidden"
      data-testid={embed ? 'cliniq-embed' : 'cliniq-standalone-app'}
    >
      {!embed && showSidebar && (
        <Sidebar onAsk={ask} onNew={newChat} active={active} returnHref={returnHref} user={user} role={role} />
      )}

      <main className="relative flex-1 flex flex-col min-w-0">
        <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none">
          <div className="pointer-events-auto">
            {!embed && (
              <button
                type="button"
                onClick={() => setShowSidebar((v) => !v)}
                className="w-8 h-8 grid place-items-center rounded-lg text-slate-500 hover:text-ink hover:bg-[#e7ecdf]"
                aria-label={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
              >
                {showSidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
              </button>
            )}
          </div>
          <div className="pointer-events-auto">{liveToggle}</div>
        </div>
        <ChatView hero embed={embed} className="flex-1 h-full" />
      </main>

      {showLiveStrip && (
        <div className="w-80 lg:w-96 shrink-0 h-full border-l border-line">
          <LiveAgentStrip onReplayAudit={(audit) => injectReplayMessage(audit)} className="h-full" />
        </div>
      )}
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
