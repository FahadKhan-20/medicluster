import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ExternalLink, MapPin } from 'lucide-react';

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// Small HTML pins in the MediCluster palette (no image assets, so nothing breaks under the bundler).
const pin = (bg, ring, glyph) =>
  L.divIcon({
    className: 'mc-map-pin',
    html: `<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:999px;background:${bg};color:#fff;font:700 11px/1 'Hanken Grotesk',sans-serif;box-shadow:0 0 0 3px ${ring},0 6px 14px rgba(23,37,29,.35)">${glyph}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

/**
 * Interactive map for chat cards: a centre point (the place the user asked about) plus optional
 * labelled points (e.g. ambulances). Fits every point in view; scroll-zoom only after a click so
 * the chat keeps scrolling normally.
 */
export default function MiniMap({ lat, lng, points = [], title = 'Location', height = 260, className = '' }) {
  const host = useRef(null);
  const cLat = num(lat);
  const cLng = num(lng);
  const pts = points
    .map((p) => ({ ...p, lat: num(p.lat), lng: num(p.lng) }))
    .filter((p) => valid(p.lat, p.lng));
  const hasCentre = valid(cLat, cLng);
  const key = JSON.stringify([cLat, cLng, pts.map((p) => [p.lat, p.lng, p.label])]);

  useEffect(() => {
    if (!host.current || (!hasCentre && !pts.length)) return undefined;
    const map = L.map(host.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix(false);

    const bounds = [];
    if (hasCentre) {
      L.marker([cLat, cLng], { icon: pin('#ad633f', '#f6e3d6', '●'), title: 'Requested location', zIndexOffset: 500 })
        .bindTooltip('You / requested location', { direction: 'top', offset: [0, -14] })
        .addTo(map);
      bounds.push([cLat, cLng]);
    }
    pts.forEach((p, i) => {
      L.marker([p.lat, p.lng], { icon: pin('#17251d', '#dfe8d3', String(i + 1)), title: p.label })
        .bindTooltip(p.label || `Unit ${i + 1}`, { direction: 'top', offset: [0, -14] })
        .addTo(map);
      bounds.push([p.lat, p.lng]);
      if (hasCentre) {
        L.polyline([[cLat, cLng], [p.lat, p.lng]], { color: '#17251d', weight: 2, opacity: 0.35, dashArray: '4 6' }).addTo(map);
      }
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    else map.setView(bounds[0], 15);

    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!hasCentre && !pts.length) return null;
  const fLat = hasCentre ? cLat : pts[0].lat;
  const fLng = hasCentre ? cLng : pts[0].lng;
  const osmUrl = `https://www.openstreetmap.org/?mlat=${fLat.toFixed(5)}&mlon=${fLng.toFixed(5)}#map=14/${fLat.toFixed(5)}/${fLng.toFixed(5)}`;

  return (
    <div className={`rounded-xl border border-line overflow-hidden bg-white ${className}`} data-testid="mini-osm-map">
      <div className="relative w-full" style={{ height }}>
        <div ref={host} className="absolute inset-0" role="img" aria-label={title} />
        <div className="absolute top-2 left-2 z-[500] bg-white/95 text-[11px] px-2 py-1 rounded-lg shadow-sm border border-line flex items-center gap-1 font-mono text-ink">
          <MapPin size={11} className="text-[#ad633f]" />
          <span>{fLat.toFixed(4)}, {fLng.toFixed(4)}</span>
        </div>
      </div>
      <div className="px-3 py-1.5 bg-white text-[11.5px] text-slate-500 flex justify-between items-center border-t border-line">
        <span className="flex items-center gap-3">
          {hasCentre && <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-[#ad633f] inline-block" /> Requested</span>}
          {pts.length > 0 && <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full bg-ink inline-block" /> Units</span>}
        </span>
        <a href={osmUrl} target="_blank" rel="noopener noreferrer" className="text-accent-700 hover:underline flex items-center gap-1">
          <span>Open map</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}
