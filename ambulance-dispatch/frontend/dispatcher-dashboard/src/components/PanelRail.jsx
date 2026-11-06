import React from 'react';
import { Box } from '@mui/material';
import KeyboardDoubleArrowLeftIcon from '@mui/icons-material/KeyboardDoubleArrowLeft';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import { T, MONO } from '../theme/dispatchTokens';

/** Thin strip shown in place of a closed side panel; clicking it reopens the panel. */
export default function PanelRail({ side, label, count, onOpen }) {
  const Icon = side === 'left' ? KeyboardDoubleArrowRightIcon : KeyboardDoubleArrowLeftIcon;
  return (
    <Box component="button" type="button" onClick={onOpen} aria-label={`Open ${label} panel`} aria-expanded={false}
      sx={{
        display: { xs: 'none', lg: 'flex' }, flexDirection: 'column', alignItems: 'center', gap: '12px',
        minHeight: 0, width: '100%', py: '14px', px: 0, cursor: 'pointer',
        border: 0, borderRadius: '22px', background: 'transparent', color: T.tx, font: 'inherit',
        '&:hover': { background: T.sf2 }, '&:focus-visible': { outline: `2px solid ${T.ac}`, outlineOffset: 2 },
      }}>
      <Icon sx={{ fontSize: 18, color: T.tx2 }} />
      {count != null && (
        <Box component="span" sx={{ minWidth: 22, height: 22, px: '6px', borderRadius: '999px', background: T.tx, color: T.bg,
          fontFamily: MONO, fontSize: 11, lineHeight: '22px', textAlign: 'center' }}>
          {count}
        </Box>
      )}
      <Box component="span" sx={{ writingMode: 'vertical-rl', transform: side === 'left' ? 'rotate(180deg)' : 'none',
        fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
        {label}
      </Box>
    </Box>
  );
}

/** Small icon button that closes a side panel (desktop only). */
export function PanelCloseButton({ side, label, onClose }) {
  const Icon = side === 'left' ? KeyboardDoubleArrowLeftIcon : KeyboardDoubleArrowRightIcon;
  return (
    <Box component="button" type="button" onClick={onClose} aria-label={`Close ${label} panel`} aria-expanded title={`Close ${label}`}
      sx={{
        display: { xs: 'none', lg: 'inline-flex' }, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: 30, height: 30, p: 0, border: `1px solid ${T.bd2}`, borderRadius: '999px', background: T.sf, color: T.tx2, cursor: 'pointer',
        '&:hover': { background: T.sf2, color: T.tx }, '&:focus-visible': { outline: `2px solid ${T.ac}`, outlineOffset: 2 },
      }}>
      <Icon sx={{ fontSize: 17 }} />
    </Box>
  );
}
