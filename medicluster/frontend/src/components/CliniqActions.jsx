import { useRef, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { cliniqAction } from '../api/apiClient';
import { DISPATCH_URL } from '../navigation';
import ActionConfirmCard from '../chat/ActionConfirmCard';
import {
  identifyResultCard,
  AmbulanceListCard,
  EmergencyTrackingCard,
  AlertCard,
  ImagingFindingCard,
  RiskCard,
  AgentDecisionCard,
  CodeBlueCard,
} from '../chat/chatCards';

const labels = {
  send_sos: 'Request emergency help',
  book_appointment: 'Request appointment',
  change_appointment: 'Change appointment',
  log_reading: 'Save reading',
  create_reminder: 'Create medication reminder',
  change_reminder: 'Change reminder',
  analyze_image: 'Analyze image',
  acknowledge_alert: 'Acknowledge alert',
};

const friendly = (value) => String(value || '').replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

function AppLink({ link }) {
  if (typeof link?.href !== 'string') return null;
  if (link.href === '/dispatch') {
    return (
      <a className="underline text-sm" href={DISPATCH_URL} target="_blank" rel="noopener noreferrer">
        {link.title}
      </a>
    );
  }
  if (/^\/(?!\/)[a-z][a-z0-9/-]*(?:\?[a-zA-Z0-9_=%&.-]*)?$/.test(link.href)) {
    return (
      <Link className="underline text-sm" to={link.href}>
        {link.title}
      </Link>
    );
  }
  try {
    const url = new URL(link.href);
    if (url.protocol === 'https:' && url.hostname === 'www.openstreetmap.org') {
      return (
        <a className="underline text-sm" href={url.href} target="_blank" rel="noopener noreferrer">
          {link.title}
        </a>
      );
    }
  } catch {}
  return null;
}

function ToolResult({ result, onSelect }) {
  if (result.error) {
    return <p role="status" className="text-sm text-red-700">{friendly(result.tool)}: {result.error}</p>;
  }
  const data = result.data;
  if (!data || data.pending) return null;

  // Check specialized rich result cards
  const cardType = identifyResultCard(result);
  if (cardType === 'ambulance_list') return <AmbulanceListCard result={result} />;
  if (cardType === 'emergency_tracking') return <EmergencyTrackingCard result={result} />;
  if (cardType === 'alert') return <AlertCard result={result} />;
  if (cardType === 'imaging_finding') return <ImagingFindingCard result={result} />;
  if (cardType === 'risk') return <RiskCard result={result} />;
  if (cardType === 'agent_decision') return <AgentDecisionCard result={result} />;
  if (cardType === 'codeblue') return <CodeBlueCard result={result} />;

  // Default fallback renderings
  if (data.hospitals) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-slate-500">{data.locationSource} · OpenStreetMap</p>
        {data.hospitals.length === 0 && <p>No facilities returned in this radius.</p>}
        {data.hospitals.map((h, i) => (
          <div key={i} className="border border-line rounded-xl p-3 text-sm">
            <strong>{h.name}</strong>
            <p>{h.distanceKm} km · {h.address}</p>
            {h.phone && <p>{h.phone}</p>}
            <AppLink link={{ title: 'Open map', href: h.mapUrl }} />
          </div>
        ))}
        <p className="text-xs text-slate-500">{data.note}</p>
      </div>
    );
  }
  if (data.matches) {
    return (
      <div className="space-y-2">
        <p className="text-sm">{data.matches.length ? 'Select patient to continue:' : 'No matching patient found.'}</p>
        {data.matches.map((p, i) => (
          <button
            key={i}
            type="button"
            className="block text-left underline text-sm"
            onClick={() =>
              onSelect?.(
                `Use patient ID ${p.patientId}${p.datasetId ? ` from dataset ${p.datasetId}` : ''}. Please show their record.`,
                { patientId: p.patientId, ...(p.datasetId ? { datasetId: p.datasetId } : {}) }
              )
            }
          >
            {p.name} · {p.patientId}
            {p.datasetId ? ` · dataset ${p.datasetId}` : ''}
          </button>
        ))}
      </div>
    );
  }
  if (data.features) {
    return (
      <div className="flex flex-wrap gap-3">
        {data.features.map((f) => (
          <AppLink key={f.feature} link={f} />
        ))}
      </div>
    );
  }
  if (data.needsLocation) return <p className="text-sm">{data.message}</p>;
  if (data.data !== undefined) {
    return (
      <details className="text-sm">
        <summary className="cursor-pointer">{friendly(result.tool)} · verified result</summary>
        <pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto text-xs mt-2">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      </details>
    );
  }
  return null;
}

export default function CliniqActions({ data, onSelect, onLocation }) {
  if (!data) return null;
  const links = [
    ...(data.links || []),
    ...(data.results || []).flatMap((r) => r.data?.links || []),
  ].filter((l, i, all) => all.findIndex((x) => x.href === l.href) === i);

  return (
    <div className="mt-3 space-y-3 min-w-0">
      {(data.results || []).map((r, i) => (
        <ToolResult key={i} result={r} onSelect={onSelect} />
      ))}
      {(data.actions || []).map((a) => (
        <ActionConfirmCard key={a.id} action={a} />
      ))}
      {data.needsLocation && onLocation && (
        <button
          type="button"
          className="rounded-full border border-line px-4 py-2 text-sm hover:bg-slate-50 transition-colors"
          onClick={onLocation}
        >
          Share location and retry
        </button>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {links.map((l, i) => (
            <AppLink key={i} link={l} />
          ))}
        </div>
      )}
      {data.model && <p className="text-[10px] text-slate-500">{data.provider} · {data.model}</p>}
    </div>
  );
}
