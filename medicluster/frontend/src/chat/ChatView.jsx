import React, { useRef, useState, useEffect } from 'react';
import { useCliniqChat } from './ChatContext';
import CliniqActions from '../components/CliniqActions';
import SuggestedChips from './SuggestedChips';
import StepTimeline from './StepTimeline';
import {
  Send,
  Paperclip,
  X,
  RotateCcw,
  Sparkles,
  Bot,
  AlertCircle,
  ChevronDown,
  Globe,
} from 'lucide-react';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिंदी' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
  { code: 'te', label: 'తెలుగు' },
  { code: 'ta', label: 'தமிழ்' },
];

function parseInline(text) {
  if (!text) return null;
  const regex = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  const parts = text.split(regex);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (part.startsWith('[') && part.includes('](') && part.endsWith(')')) {
      const match = part.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (match && /^https?:\/\//i.test(match[2])) {
        return (
          <a
            key={idx}
            href={match[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium break-all"
          >
            {match[1]}
          </a>
        );
      }
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (
      (part.startsWith('*') && part.endsWith('*') && part.length >= 2) ||
      (part.startsWith('_') && part.endsWith('_') && part.length >= 2)
    ) {
      return (
        <em key={idx} className="italic text-slate-800">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={idx} className="px-1.5 py-0.5 bg-slate-100 text-slate-800 rounded text-[12px] font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

export function renderChatMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      elements.push(<div key={`empty-${i}`} className="h-1.5" />);
      continue;
    }

    if (trimmed.startsWith('### ')) {
      elements.push(
        <h3 key={`h3-${i}`} className="text-[14px] font-bold text-ink mt-3 mb-1 pb-0.5 border-b border-line">
          {parseInline(trimmed.replace(/^###\s+/, ''))}
        </h3>
      );
      continue;
    }
    if (trimmed.startsWith('## ')) {
      elements.push(
        <h2 key={`h2-${i}`} className="text-[15px] font-bold text-ink mt-3.5 mb-1.5 pb-1 border-b border-line">
          {parseInline(trimmed.replace(/^##\s+/, ''))}
        </h2>
      );
      continue;
    }
    if (trimmed.startsWith('# ')) {
      elements.push(
        <h1 key={`h1-${i}`} className="text-[16px] font-bold text-ink mt-4 mb-2">
          {parseInline(trimmed.replace(/^#\s+/, ''))}
        </h1>
      );
      continue;
    }

    if (/^[\*\-\+\•]\s+/.test(trimmed)) {
      elements.push(
        <div key={`bullet-${i}`} className="flex items-start gap-2 my-0.5 pl-1 text-[13.5px]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400 mt-2 shrink-0" aria-hidden="true" />
          <div className="flex-1 text-slate-700 leading-relaxed">
            {parseInline(trimmed.replace(/^[\*\-\+\•]\s+/, ''))}
          </div>
        </div>
      );
      continue;
    }

    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={`num-${i}`} className="flex items-start gap-2 my-0.5 pl-1 text-[13.5px]">
          <span className="font-semibold text-slate-800 text-[12px] shrink-0 min-w-[1.2rem]">
            {numMatch[1]}.
          </span>
          <div className="flex-1 text-slate-700 leading-relaxed">
            {parseInline(numMatch[2])}
          </div>
        </div>
      );
      continue;
    }

    elements.push(
      <p key={`p-${i}`} className="my-1 text-[13.5px] text-slate-700 leading-relaxed">
        {parseInline(rawLine)}
      </p>
    );
  }

  return <div className="space-y-0.5">{elements}</div>;
}

export default function ChatView({
  isPanel = false,
  showSuggestedChips = true,
  onClose,
  className = '',
}) {
  const {
    messages,
    loading,
    error,
    language,
    setLanguage,
    userLocation,
    setUserLocation,
    handleChatSubmit,
    reset,
  } = useCliniqChat();

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  const scrollBottom = () => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  };

  useEffect(() => {
    scrollBottom();
  }, [messages.length, loading]);

  const handleSubmit = (e) => {
    if (e) e.preventDefault();
    if ((!input.trim() && attachments.length === 0) || loading) return;

    const textToSend = input;
    const filesToSend = attachments.map((a) => a.file);

    setInput('');
    setAttachments([]);
    handleChatSubmit(textToSend, filesToSend);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const newAttachments = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      name: file.name,
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);
    e.target.value = '';
  };

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const count = messages.length;

  return (
    <div
      className={`flex flex-col h-full bg-paper text-ink overflow-hidden ${className}`}
      data-testid="chat-view"
    >
      {/* Top Header / Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-paper/90 backdrop-blur-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800 shrink-0">
            <Bot size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs text-ink truncate">MediCluster Agent</span>
              <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200">
                CliniQ Core
              </span>
            </div>
            <p className="text-[11px] text-slate-500 truncate">
              {count ? `${count} message${count === 1 ? '' : 's'} in session` : 'Ask anything or run drills'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 text-[11px] text-slate-600 bg-white border border-line rounded px-1.5 py-0.5">
            <Globe size={11} className="text-slate-400" />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-transparent focus:outline-none cursor-pointer text-ink text-[11px]"
              aria-label="Language selection"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {count > 0 && (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-ink px-2 py-1 rounded hover:bg-slate-100 transition-colors"
              title="Reset conversation"
            >
              <RotateCcw size={12} />
              <span>Reset</span>
            </button>
          )}

          {isPanel && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors"
              aria-label="Close chat panel"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Messages Scroll View */}
      <div
        className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
        role="log"
        aria-live="polite"
        data-testid="chat-message-list"
      >
        {count === 0 && (
          <div className="py-4 space-y-4">
            <div className="p-4 rounded-2xl bg-white border border-line space-y-2 text-center">
              <div className="inline-flex p-2.5 rounded-full bg-emerald-50 text-emerald-800 mb-1">
                <Sparkles size={20} />
              </div>
              <h3 className="font-semibold text-sm text-ink">Ask MediCluster Agent</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">
                Surveillance, emergency dispatch, imaging, deterioration analysis, and Code Blue protocols.
              </p>
            </div>

            {showSuggestedChips && (
              <SuggestedChips
                onSelect={(query) => handleChatSubmit(query)}
                disabled={loading}
              />
            )}
          </div>
        )}

        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <div key={i} className="flex justify-end" data-testid="chat-user-message">
              <div className="max-w-[85%] space-y-1.5">
                {msg.images && msg.images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {msg.images.map((img, idx) => (
                      <figure key={idx} className="rounded-lg overflow-hidden border border-line bg-white shadow-2xs max-w-[140px]">
                        <img src={img.preview} alt={img.name} className="w-full aspect-[4/3] object-cover" />
                        <figcaption className="text-[10px] text-slate-500 px-1 py-0.5 truncate text-center">
                          {img.name}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}
                {msg.content && (
                  <div className="p-3 rounded-2xl rounded-br-sm bg-ink text-paper text-[13.5px] leading-relaxed shadow-xs">
                    {msg.content}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div key={i} className="flex gap-2.5 items-start" data-testid="chat-assistant-message">
              <span className="w-6 h-6 rounded-full bg-emerald-800 text-white grid place-items-center text-xs font-semibold shrink-0 mt-0.5">
                Q
              </span>
              <div className="flex-1 min-w-0 space-y-2">
                <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white border border-line text-[13.5px] text-ink shadow-xs">
                  {renderChatMarkdown(msg.content)}
                  {msg.agent && <StepTimeline agentData={msg.agent} />}
                  {msg.agent && (
                    <CliniqActions
                      data={msg.agent}
                      onSelect={(text, selected) => handleChatSubmit(text, [], undefined, selected)}
                      onLocation={() => {
                        if (!navigator.geolocation) return;
                        navigator.geolocation.getCurrentPosition(
                          (pos) => {
                            const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
                            setUserLocation(loc);
                            handleChatSubmit(msg.requestQuestion || 'My location', msg.requestFiles || [], loc);
                          },
                          () => {},
                          { timeout: 8000, maximumAge: 0 }
                        );
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex items-center gap-2.5 text-xs text-slate-500 py-2" data-testid="chat-thinking">
            <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 grid place-items-center">
              <span className="w-3.5 h-3.5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
            </span>
            <span className="italic font-medium">Agent is thinking…</span>
          </div>
        )}

        {count > 0 && !loading && showSuggestedChips && (
          <div className="pt-2">
            <details className="group">
              <summary className="text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer select-none flex items-center gap-1">
                <span>Suggested prompts</span>
                <ChevronDown size={11} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2">
                <SuggestedChips
                  onSelect={(query) => handleChatSubmit(query)}
                  disabled={loading}
                />
              </div>
            </details>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer Section */}
      <div className="p-3 border-t border-line bg-white shrink-0">
        {error && (
          <div className="mb-2 p-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-1.5" role="alert">
            <AlertCircle size={14} className="shrink-0 text-red-600" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        {/* Attachment preview pills */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-paper border border-line text-xs text-ink"
              >
                <img src={att.preview} alt="" className="w-4 h-4 rounded object-cover" />
                <span className="max-w-[120px] truncate">{att.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  className="p-0.5 rounded-full hover:bg-slate-200 text-slate-500"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="relative flex items-end gap-1.5">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="p-2 rounded-xl text-slate-500 hover:text-ink hover:bg-slate-100 transition-colors disabled:opacity-50"
            title="Attach clinical image"
            aria-label="Attach clinical image"
          >
            <Paperclip size={17} />
          </button>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder={count ? 'Ask follow-up or enter instruction…' : 'Ask anything, e.g. "Nearest ambulance to P001"'}
            rows={1}
            className="flex-1 max-h-32 min-h-[38px] p-2 text-xs md:text-sm bg-paper border border-line rounded-xl focus:outline-none focus:border-slate-400 resize-none leading-relaxed text-ink placeholder:text-slate-400"
            style={{ height: 'auto', minHeight: '38px' }}
          />

          <button
            type="submit"
            disabled={loading || (!input.trim() && attachments.length === 0)}
            className="p-2 rounded-xl bg-ink text-paper hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            title="Send message"
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </form>

        <p className="text-[10px] text-slate-400 text-center mt-2">
          AI guidance only · Clinician confirms all actions & risk outputs
        </p>
      </div>
    </div>
  );
}
