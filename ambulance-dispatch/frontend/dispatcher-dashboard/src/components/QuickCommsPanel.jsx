import React, { useState, useRef, useEffect } from 'react';
import { Box, Typography, Button } from '@mui/material';

import { T, MONO, btnSx } from '../theme/dispatchTokens';

const PRESETS = [
  { label:'Request backup',            category:'critical',text:'URGENT: Requesting backup at current location. Additional unit needed immediately.' },
  { label:'All units: Stand by',        category:'ops',    text:'All units: Stand by for further instructions.' },
  { label:'Avoid NH44 — heavy traffic', category:'route',  text:'All units: Avoid NH44 due to heavy traffic. Use alternate route via Ring Road.' },
  { label:'Code 3 — lights & sirens',   category:'ops',    text:'Alpha-1: Proceed Code 3, lights and sirens authorised.' },
  { label:'Return to base',             category:'ops',    text:'Unit: Mission complete — return to base when available.' },
  { label:'Confirm ETA',               category:'info',   text:'Unit: Please confirm your ETA to scene.' },
  { label:'Scene secured',             category:'info',   text:'All units: Scene secured by police. Safe to approach.' },
  { label:'Hospital on standby',       category:'hospital',text:'Alpha-1: AIIMS ER on standby — trauma team activated.' },
];

export default function QuickCommsPanel({ ambulances = [] }) {
  const units = ['All Units', ...ambulances.map(a => a.call_sign).filter(Boolean)];
  const [unit, setUnit]           = useState('All Units');
  const [custom, setCustom]       = useState('');
  const [log, setLog]             = useState(() => [
    { id:1, from:'Control', to:'All', text:'Morning briefing: 8 units on shift', ts:Date.now()-3600000 },
    { id:2, from:'Alpha-1', to:'Control', text:'Alpha-1 ready for dispatch', ts:Date.now()-1800000 },
  ]);
  const [sending, setSending]     = useState(false);
  const logRef                    = useRef(null);

  // Scroll only the log itself; scrollIntoView would also scroll the page columns.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const send = (text) => {
    if (!text.trim()) return;
    setSending(true);
    setTimeout(() => {
      setLog(prev => [...prev, {
        id: Date.now(), from:'Control', to: unit,
        text: text.trim().replace('Unit:', `${unit}:`).replace('Alpha-1:', `${unit}:`),
        ts: Date.now(), _sent:true,
      }]);
      setCustom('');
      setSending(false);
      // Simulate unit reply after 3–8s
      setTimeout(() => {
        const replies = ['Roger that. Acknowledged.', 'Copy. Wilco.', 'Understood. Proceeding.', 'Received. On it.'];
        setLog(prev => [...prev, {
          id: Date.now()+1,
          from: unit === 'All Units' ? 'Alpha-1' : unit,
          to:'Control',
          text: replies[Math.floor(Math.random()*replies.length)],
          ts:Date.now(), _reply:true,
        }]);
      }, 3000 + Math.random()*5000);
    }, 600);
  };

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  }

  const metaSx = { fontFamily: MONO, fontSize: 10.5, color: T.tx3, mt: '4px' };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 400, flex: 1, p:'18px', borderRadius:'24px', background:'transparent' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', pb: '8px', borderBottom: `1px solid ${T.bd}` }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>Radio</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: MONO, fontSize: 11, color: T.gT }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: T.g }} />CH 1
        </Box>
      </Box>

      <Box ref={logRef} role="log" aria-live="polite" sx={{ flex: 1, minHeight: 120, overflow: 'auto', py: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {log.map(msg => {
          const fromControl = msg.from === 'Control';
          return (
            <Box key={msg.id} sx={{ display: 'flex', flexDirection: 'column', alignItems: fromControl ? 'flex-end' : 'flex-start' }}>
              <Box sx={{
                maxWidth: '86%', p: '9px 11px', borderRadius: '16px', fontSize: 13.5, lineHeight: 1.45,
                background: fromControl ? T.tx : T.sf2, color: fromControl ? T.bg : T.tx,
              }}>
                {msg.text}
              </Box>
              <Typography sx={metaSx}>{msg.from} → {msg.to} · {fmtTime(msg.ts)}</Typography>
            </Box>
          );
        })}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0, pt: '10px', borderTop: `1px solid ${T.bd}` }}>
        {/* Quick messages: one line, scrolls sideways. */}
        <Box role="group" aria-label="Quick messages" sx={{
          display: 'flex', gap: '6px', overflowX: 'auto', pb: '2px', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
          maskImage: 'linear-gradient(90deg, #000 88%, transparent)',
        }}>
          {PRESETS.map(p => (
            <Button key={p.label} disabled={sending} onClick={() => send(p.text)}
              sx={{ ...btnSx(false), flexShrink: 0, height: 28, px: '10px', fontSize: 12, whiteSpace: 'nowrap',
                ...(p.category === 'critical' && { borderColor: T.r, color: T.rT }) }}>
              {p.label}
            </Button>
          ))}
        </Box>
        <Box component="form" onSubmit={e => { e.preventDefault(); send(custom); }}
          sx={{ display: 'flex', alignItems: 'center', gap: '6px', p: '4px', border: `1px solid ${T.bd2}`, borderRadius: '999px', background: T.sf,
            '&:focus-within': { borderColor: T.tx } }}>
          <Box component="select" id="radio-unit" value={unit} onChange={e => setUnit(e.target.value)} aria-label="Send to"
            sx={{ flexShrink: 0, maxWidth: 104, height: 30, px: '8px', border: 0, borderRadius: '999px', background: T.sf2, color: T.tx, font: 'inherit', fontSize: 12, cursor: 'pointer' }}>
            {units.map(u => <option key={u}>{u}</option>)}
          </Box>
          <Box component="input" value={custom} onChange={e => setCustom(e.target.value)}
            placeholder="Message" aria-label={`Message to ${unit}`}
            sx={{ flex: 1, minWidth: 0, height: 30, px: '4px', border: 0, background: 'transparent', color: T.tx, font: 'inherit', fontSize: 13, outline: 'none' }} />
          <Button type="submit" disabled={sending || !custom.trim()} sx={{ ...btnSx(true), flexShrink: 0, height: 30, minWidth: 0, px: '14px' }}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
