/* Custom SVG map markers for the dispatch map: one compact shape and at most one label per marker. */

const STATUS_COLORS = {
  AVAILABLE: '#059669',
  ASSIGNED: '#CA8A04',
  EN_ROUTE_TO_SCENE: '#EA580C',
  EN_ROUTE: '#EA580C',
  ON_SCENE: '#DC2626',
  TRANSPORTING_TO_HOSPITAL: '#2563EB',
  TRANSPORTING: '#2563EB',
  ARRIVED_AT_HOSPITAL: '#7C3AED',
  RETURNING_TO_BASE: '#475569',
  MAINTENANCE: '#94A3B8',
  OFFLINE: '#94A3B8',
};
const SEVERITY_COLORS = { CRITICAL: '#DC2626', HIGH: '#EA580C', MEDIUM: '#D97706', LOW: '#0891B2' };
const STALE_AFTER_MS = 60000;

// White glyphs drawn in a 24×24 box. `accent` is used for details cut into the glyph.
const GLYPHS = {
  ambulance: (accent) => `
    <path d="M2 8.5A1.5 1.5 0 0 1 3.5 7H13v9H2z" fill="#fff"/>
    <path d="M13 10h3.6a1 1 0 0 1 .8.4L20 13.6V16h-7z" fill="#fff"/>
    <path d="M7.5 9.2v4.6M5.2 11.5h4.6" stroke="${accent}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="6" cy="17" r="2.1" fill="#fff" stroke="${accent}" stroke-width="1.4"/>
    <circle cx="16" cy="17" r="2.1" fill="#fff" stroke="${accent}" stroke-width="1.4"/>`,
  heart: () => `<path d="M12 20s-7-4.4-7-10.2A4 4 0 0 1 12 7.3a4 4 0 0 1 7 2.5C19 15.6 12 20 12 20z" fill="#fff"/>`,
  car: (accent) => `
    <path d="M4.5 15.5 6.2 10.6A2 2 0 0 1 8.1 9.2h7.8a2 2 0 0 1 1.9 1.4l1.7 4.9V18h-2.6v-1.4H7.1V18H4.5z" fill="#fff"/>
    <circle cx="8" cy="14" r="1.1" fill="${accent}"/><circle cx="16" cy="14" r="1.1" fill="${accent}"/>`,
  flame: () => `<path d="M12 3c1 3.6 5.2 5.6 5.2 10.2a5.2 5.2 0 0 1-10.4 0c0-2.6 1.5-4.1 2.6-5.1.3 1.6 1 2.6 2 3 .3-3.1-.5-5.6.6-8.1z" fill="#fff"/>`,
  person: () => `<circle cx="12" cy="5.8" r="2.4" fill="#fff"/><path d="M12 9.4c-2.3 0-3.7 1.3-3.7 3.4V16h2.1v4h3.2v-4h2.1v-3.2c0-2.1-1.4-3.4-3.7-3.4z" fill="#fff"/>`,
  alert: () => `<rect x="10.8" y="5.5" width="2.4" height="8.5" rx="1.2" fill="#fff"/><circle cx="12" cy="17.6" r="1.5" fill="#fff"/>`,
  hospital: () => `<path d="M10 5h4v5h5v4h-5v5h-4v-5H5v-4h5z" fill="#fff"/>`,
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const glyph = (name, x, y, size, accent) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${GLYPHS[name](accent)}</svg>`;

export function incidentGlyph(type) {
  const t = String(type || '').toUpperCase();
  if (/CARDIAC|HEART|CHEST|STROKE/.test(t)) return 'heart';
  if (/ACCIDENT|CRASH|COLLISION|VEHICLE|ROAD/.test(t)) return 'car';
  if (/FIRE|BURN/.test(t)) return 'flame';
  if (/TRAUMA|FALL|INJURY|ASSAULT/.test(t)) return 'person';
  return 'alert';
}

export function routeBadgeText(callsign, km, minutes) {
  return `${callsign} · ${km} km · ${minutes} min`;
}

const isStale = (amb, now) => amb.last_ping != null && now - new Date(amb.last_ping).getTime() > STALE_AFTER_MS;

/** Changes exactly when an ambulance marker must be redrawn (not on plain moves). */
export function ambulanceMarkerKey(amb, { now = Date.now() } = {}) {
  return [amb.status, amb.call_sign || amb.vehicle_number || amb.id, isStale(amb, now)].join('|');
}

/** Changes exactly when an incident marker must be redrawn. */
export function incidentMarkerKey(inc) {
  return [String(inc.severity || 'HIGH').toUpperCase(), incidentGlyph(inc.incident_type)].join('|');
}

export function ambulanceMarkerHtml(amb, { now = Date.now() } = {}) {
  const stale = isStale(amb, now);
  const color = stale ? '#94A3B8' : STATUS_COLORS[amb.status] || STATUS_COLORS.AVAILABLE;
  const callsign = amb.call_sign || amb.vehicle_number || amb.id || 'Unit';
  return `
    <div class="mk mk-ambulance${stale ? ' mk-stale' : ''}" style="--mk-color:${color}">
      <span class="mk-label amb-live-badge">${esc(callsign)}</span>
      <div class="mk-puck">
        <svg data-glyph="ambulance" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13" fill="${color}" stroke="#fff" stroke-width="2.5"${stale ? ' stroke-dasharray="4 3"' : ''}/>
          ${glyph('ambulance', 6, 6, 20, color)}
        </svg>
        <div class="mk-heading vehicle-icon-rotator"><svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 -1.5 19.5 3.5h-7z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
      </div>
    </div>`;
}

export function incidentMarkerHtml(inc) {
  const severity = String(inc.severity || 'HIGH').toUpperCase();
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.HIGH;
  const name = incidentGlyph(inc.incident_type);
  return `
    <div class="mk mk-incident" style="--mk-color:${color}" title="${esc(`${severity} · ${inc.incident_type || 'Incident'}`)}">
      ${severity === 'CRITICAL' ? '<span class="mk-pulse"></span>' : ''}
      <svg data-glyph="${name}" width="30" height="38" viewBox="0 0 30 38" aria-hidden="true">
        <path d="M15 36.5S3.5 23.6 3.5 15a11.5 11.5 0 1 1 23 0c0 8.6-11.5 21.5-11.5 21.5z" fill="${color}" stroke="#fff" stroke-width="2"/>
        ${glyph(name, 7, 7, 16, color)}
      </svg>
    </div>`;
}

export function hospitalMarkerHtml(h) {
  const beds = h.available_beds ?? 12;
  const color = beds > 10 ? '#2563EB' : beds > 3 ? '#D97706' : '#DC2626';
  return `
    <div class="mk mk-hospital" style="--mk-color:${color}" title="${esc(h.name || 'Hospital')}">
      <svg data-glyph="hospital" width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
        <path d="M6 1.5h14A4.5 4.5 0 0 1 24.5 6v14a4.5 4.5 0 0 1-4.5 4.5h-4L13 28.5l-3-4H6A4.5 4.5 0 0 1 1.5 20V6A4.5 4.5 0 0 1 6 1.5z" fill="${color}" stroke="#fff" stroke-width="2"/>
        ${glyph('hospital', 5, 5, 16, color)}
      </svg>
    </div>`;
}

const MARKER_CSS = `
.mk{display:flex;flex-direction:column;align-items:center;position:relative;pointer-events:auto;cursor:pointer;font-family:'Inter',system-ui,sans-serif;filter:drop-shadow(0 2px 3px rgba(15,23,42,.28))}
.mk-label{margin-bottom:3px;padding:3px 7px;border-radius:6px;background:#fff;color:#0F172A;font-size:10px;font-weight:600;line-height:1.2;white-space:nowrap;border:1px solid rgba(15,23,42,.1)}
.mk-puck{position:relative;width:32px;height:32px}
.mk-puck>svg{display:block}
.mk-heading{position:absolute;inset:0;transition:transform .15s linear}
.mk-stale .mk-heading{display:none}
.mk-stale .mk-label{color:#64748B}
.mk-pulse{position:absolute;left:50%;top:15px;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:var(--mk-color);animation:mk-pulse 1.6s ease-out infinite;z-index:-1}
@keyframes mk-pulse{from{transform:scale(.7);opacity:.55}to{transform:scale(2.1);opacity:0}}
@media (prefers-reduced-motion:reduce){.mk-pulse{animation:none;opacity:.25;transform:scale(1.4)}}
.mk-zoomed-out .mk-label{display:none}
`;

export function ensureMarkerStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById('mk-marker-styles')) return;
  const style = doc.createElement('style');
  style.id = 'mk-marker-styles';
  style.textContent = MARKER_CSS;
  doc.head.appendChild(style);
}
