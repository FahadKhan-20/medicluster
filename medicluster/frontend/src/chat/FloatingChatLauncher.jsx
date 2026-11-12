import React, { useEffect } from 'react';
import { useCliniqChat } from './ChatContext';
import ChatView from './ChatView';
import { Bot, Sparkles, X, Command } from 'lucide-react';

export default function FloatingChatLauncher() {
  const { isPanelOpen, togglePanel, closePanel } = useCliniqChat();

  // Escape key closes side panel
  useEffect(() => {
    if (!isPanelOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPanelOpen, closePanel]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  return (
    <>
      {/* Floating launcher button in bottom-right */}
      <div className="fixed bottom-6 right-6 z-40 print:hidden">
        <button
          type="button"
          onClick={togglePanel}
          className="group flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-ink text-paper shadow-lg hover:shadow-xl hover:bg-slate-800 transition-all border border-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
          aria-label="Ask MediCluster Agent"
          aria-expanded={isPanelOpen}
          data-testid="floating-chat-launcher"
        >
          <span className="relative flex items-center justify-center p-1 rounded-full bg-emerald-500 text-white shrink-0">
            <Bot size={16} />
            <span className="animate-ping absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 opacity-75" />
          </span>
          <span className="font-semibold text-xs tracking-tight">Ask MediCluster Agent</span>
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
            <span>{isMac ? '⌘' : 'Ctrl+'}</span>
            <span>K</span>
          </span>
        </button>
      </div>

      {/* Slide-out side drawer */}
      {isPanelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end print:hidden" data-testid="chat-side-panel">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/25 backdrop-blur-2xs transition-opacity"
            onClick={closePanel}
            aria-hidden="true"
          />

          {/* Panel container */}
          <aside
            className="relative z-50 w-[450px] max-w-[95vw] h-full bg-paper shadow-2xl border-l border-line flex flex-col animate-in slide-in-from-right duration-200"
            role="dialog"
            aria-label="MediCluster Agent Chat Assistant"
          >
            <ChatView isPanel={true} onClose={closePanel} />
          </aside>
        </div>
      )}
    </>
  );
}
