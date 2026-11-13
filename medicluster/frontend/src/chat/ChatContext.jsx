import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { cliniqChat } from '../api/apiClient';
import { useAuth } from '../auth/AuthContext';

const ChatContext = createContext(null);

const STORAGE_KEY = 'medicluster.chat_session';

function loadSessionMessages() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // sessionStorage unavailable or parse error
  }
  return [];
}

function saveSessionMessages(messages) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Ignore storage quota or disabled storage
  }
}

export function ChatProvider({ children }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState(() => loadSessionMessages());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState('en');
  const [userLocation, setUserLocation] = useState(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const controller = useRef(null);
  const conversationId = useRef(crypto.randomUUID());
  const retry = useRef(null);
  const epoch = useRef(0);

  // Sync messages to sessionStorage whenever they change
  useEffect(() => {
    saveSessionMessages(messages);
  }, [messages]);

  // Global Ctrl/Cmd + K shortcut to toggle side panel
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setIsPanelOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Browser geolocation lookup
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (err) => {
          // Soft fail
        },
        { timeout: 8000, maximumAge: 60000 }
      );
    }
  }, [user?.id, user?._id, user?.email]);

  const togglePanel = useCallback(() => setIsPanelOpen((prev) => !prev), []);
  const openPanel = useCallback(() => setIsPanelOpen(true), []);
  const closePanel = useCallback(() => setIsPanelOpen(false), []);

  const handleChatSubmit = useCallback(
    async (question = '', attachedFiles = [], locationOverride, selectedPatient) => {
      if (!question?.trim() && (!attachedFiles || attachedFiles.length === 0)) return;

      const currentEpoch = epoch.current;
      controller.current?.abort();
      controller.current = new AbortController();
      setLoading(true);
      setError(null);

      let convertedImages = [];
      if (attachedFiles && attachedFiles.length > 0) {
        convertedImages = await Promise.all(
          attachedFiles.map((file) => {
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target.result;
                const base64 = typeof dataUrl === 'string' ? dataUrl.split(',')[1] : '';
                resolve({
                  preview: dataUrl,
                  base64,
                  mediaType: file.type || 'image/jpeg',
                  name: file.name,
                });
              };
              reader.readAsDataURL(file);
            });
          })
        );
      }

      if (currentEpoch !== epoch.current) return;

      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const next = [...messages];
      if (question?.trim() || convertedImages.length > 0) {
        next.push({
          role: 'user',
          content: question?.trim() || '',
          images: convertedImages.length > 0 ? convertedImages : undefined,
        });
      }
      setMessages(next);

      try {
        const fingerprint = JSON.stringify([question, history, convertedImages.map((img) => img.base64)]);
        if (retry.current?.fingerprint !== fingerprint) {
          retry.current = { fingerprint, id: crypto.randomUUID() };
        }

        const data = await cliniqChat(
          {
            question: question.trim(),
            history,
            language,
            location: locationOverride || userLocation,
            images: convertedImages.map(({ base64, mediaType }) => ({ base64, mediaType })),
            requestId: retry.current.id,
            conversationId: conversationId.current,
            selectedPatient,
          },
          controller.current.signal
        );

        if (currentEpoch !== epoch.current) return;
        retry.current = null;
        setMessages([
          ...next,
          {
            role: 'assistant',
            content: data.reply,
            agent: data,
            requestQuestion: question,
            requestFiles: attachedFiles,
          },
        ]);
      } catch (e) {
        if (currentEpoch !== epoch.current || e.code === 'ERR_CANCELED') return;
        setError(e.response?.data?.error || 'AI Assistant temporarily unavailable. Please try again.');
      } finally {
        if (currentEpoch === epoch.current) setLoading(false);
      }
    },
    [messages, language, userLocation]
  );

  const reset = useCallback(() => {
    epoch.current++;
    controller.current?.abort();
    retry.current = null;
    conversationId.current = crypto.randomUUID();
    setLoading(false);
    setMessages([]);
    setError(null);
    setLanguage('en');
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  const injectReplayMessage = useCallback((audit) => {
    if (!audit) return;
    const auditId = audit._id || audit.id || 'AUDIT-' + Math.random().toString(36).slice(2, 8);
    const eventName = audit.event?.kind || audit.event?.source || audit.event_type || 'Autonomous Action';
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: `### Autonomous Decision Replay: ${eventName}\nAudit ID: \`${auditId}\`\nReviewed autonomous safety & consensus outcome.`,
        agent: {
          provider: 'agent-core',
          model: 'jev-consensus-v1',
          results: [
            {
              tool: 'agent_decision',
              data: {
                audit,
                decision: audit,
              },
            },
          ],
          actions: [],
        },
      },
    ]);
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        loading,
        error,
        language,
        setLanguage,
        userLocation,
        setUserLocation,
        isPanelOpen,
        togglePanel,
        openPanel,
        closePanel,
        handleChatSubmit,
        injectReplayMessage,
        reset,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useCliniqChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useCliniqChat must be used within a ChatProvider');
  }
  return ctx;
}
