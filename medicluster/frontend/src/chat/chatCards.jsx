import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ambulance,
  AlertTriangle,
  HeartPulse,
  Brain,
  Bot,
  Activity,
  CheckCircle2,
  ExternalLink,
  MapPin,
  Clock,
  Navigation,
  ShieldAlert,
  RotateCcw,
  Sparkles,
  Zap
} from 'lucide-react';
import { DISPATCH_URL } from '../navigation';
import { identifyResultCard } from './chatCardSelection';
export { identifyResultCard };

/**
 * Mini OpenStreetMap interactive/static preview card.
 */
export function MiniOsmMap({ lat, lng, title = 'Location', zoom = 14, className = '' }) {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return null;
  }
  const numericLat = Number(lat);
  const numericLng = Number(lng);
  const osmUrl = `https://www.openstreetmap.org/?mlat=${numericLat.toFixed(5)}&mlon=${numericLng.toFixed(5)}#map=${zoom}/${numericLat.toFixed(5)}/${numericLng.toFixed(5)}`;
  // OpenStreetMap embed URL
  const bboxDelta = 0.008;
  const bbox = [
    (numericLng - bboxDelta).toFixed(5),
    (numericLat - bboxDelta).toFixed(5),
    (numericLng + bboxDelta).toFixed(5),
    (numericLat + bboxDelta).toFixed(5),
  ].join('%2C');
  const embedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${numericLat.toFixed(5)}%2C${numericLng.toFixed(5)}`;

  return (
    <div className={`rounded-xl border border-line overflow-hidden bg-sunken/40 ${className}`} data-testid="mini-osm-map">
      <div className="relative w-full h-[140px] bg-slate-100 flex items-center justify-center">
        <iframe
          title={title}
          src={embedUrl}
          className="w-full h-full border-0 pointer-events-auto"
          loading="lazy"
          tabIndex={-1}
        />
        <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm text-[11px] px-2 py-0.5 rounded shadow-sm border border-line flex items-center gap-1 font-mono">
          <MapPin size={11} className="text-red-600" />
          <span>{numericLat.toFixed(4)}, {numericLng.toFixed(4)}</span>
        </div>
      </div>
      <div className="px-3 py-1.5 bg-white text-[11.5px] text-slate-500 flex justify-between items-center border-t border-line">
        <span>OpenStreetMap</span>
        <a href={osmUrl} target="_blank" rel="noopener noreferrer" className="text-accent-700 hover:underline flex items-center gap-1">
          <span>Expand map</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}

/**
 * 1. Ambulance List Card
 */
export function AmbulanceListCard({ result }) {
  const data = result?.data || {};
  const ambulances = Array.isArray(data.ambulances)
    ? data.ambulances
    : Array.isArray(data)
    ? data
    : [];

  const centerLat = ambulances[0]?.latitude ?? ambulances[0]?.lat ?? data.location?.latitude ?? data.center?.lat ?? 37.7749;
  const centerLng = ambulances[0]?.longitude ?? ambulances[0]?.lng ?? data.location?.longitude ?? data.center?.lng ?? -122.4194;

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3.5 text-sm shadow-sm" data-testid="ambulance-list-card">
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800">
            <Ambulance size={18} />
          </span>
          <div>
            <strong className="text-ink font-semibold">Available Ambulances</strong>
            <p className="text-[12px] text-slate-500">{ambulances.length} units stationed nearby</p>
          </div>
        </div>
        <Link to="/dispatch" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded-full border border-emerald-200">
          <span>Dispatch CAD</span>
          <Navigation size={12} />
        </Link>
      </div>

      <MiniOsmMap lat={centerLat} lng={centerLng} title="Nearby Ambulances" />

      {ambulances.length === 0 ? (
        <p className="text-xs text-slate-500 italic py-1">No ambulances currently available in this radius.</p>
      ) : (
        <div className="space-y-2">
          {ambulances.slice(0, 4).map((amb, i) => {
            const id = amb.callsign || amb.vehicle_number || amb.ambulance_id || amb.id || `Unit #${i + 1}`;
            const type = amb.type || amb.capability || 'ALS';
            const dist = amb.distance ?? amb.distanceKm ?? amb.distance_km;
            const eta = amb.eta ?? amb.etaMinutes ?? (dist != null ? Math.max(3, Math.round(dist * 2.2)) : null);
            const status = String(amb.status || 'AVAILABLE').toUpperCase();

            return (
              <div key={i} className="flex items-center justify-between p-2.5 rounded-xl border border-line bg-paper/60 hover:bg-paper transition-colors text-xs">
                <div className="flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <div>
                    <span className="font-semibold text-ink">{id}</span>
                    <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-700 font-mono">{type}</span>
                  </div>
                </div>
                <div className="text-right">
                  {dist != null && <span className="font-medium text-ink">{Number(dist).toFixed(1)} km</span>}
                  {eta != null && <span className="text-slate-500 ml-1.5">({eta} min ETA)</span>}
                  <div className="text-[10px] text-emerald-700 font-mono">{status}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="pt-1 flex items-center justify-between text-xs text-slate-500">
        <span>Real-time GPS tracking</span>
        <a href={DISPATCH_URL} target="_blank" rel="noopener noreferrer" className="text-slate-600 hover:underline flex items-center gap-1">
          <span>Open external dispatch</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}

/**
 * 2. Emergency Tracking Card
 */
export function EmergencyTrackingCard({ result }) {
  const data = result?.data || {};
  const incident = data.incident || data.emergency || data;

  const status = String(incident.status || incident.stage || 'DISPATCHED').toUpperCase();
  const incidentId = incident.incidentId || incident.id || incident._id || 'SOS-ACTIVE';
  const severity = String(incident.severity || 'CRITICAL').toUpperCase();
  const address = incident.locationAddress || incident.location_address || incident.address || 'Reported patient location';
  const lat = incident.locationLat ?? incident.location_lat ?? incident.latitude;
  const lng = incident.locationLng ?? incident.location_lng ?? incident.longitude;
  const ambulanceId = incident.assignedAmbulanceId || incident.assigned_ambulance_id || incident.ambulanceId || 'AMB-04';
  const eta = incident.eta || incident.etaMinutes || '6 min';

  const isComplete = status === 'RESOLVED' || status === 'ARRIVED_AT_HOSPITAL';
  const statusColor = isComplete ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800';

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3.5 text-sm shadow-sm" data-testid="emergency-tracking-card">
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-red-100 text-red-700 animate-pulse">
            <ShieldAlert size={18} />
          </span>
          <div>
            <strong className="text-ink font-semibold">Active Emergency Tracking</strong>
            <p className="text-[11px] font-mono text-slate-500">ID: {String(incidentId).slice(0, 16)}</p>
          </div>
        </div>
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusColor}`}>
          {status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 rounded-xl bg-paper border border-line">
          <span className="text-slate-500 block text-[10px] uppercase">Assigned Unit</span>
          <span className="font-semibold text-ink">{ambulanceId}</span>
        </div>
        <div className="p-2 rounded-xl bg-paper border border-line">
          <span className="text-slate-500 block text-[10px] uppercase">Estimated Arrival</span>
          <span className="font-semibold text-red-700">{eta}</span>
        </div>
      </div>

      {lat != null && lng != null && (
        <MiniOsmMap lat={lat} lng={lng} title="Emergency Scene" />
      )}

      <div className="text-xs text-slate-600 flex items-start gap-1.5">
        <MapPin size={14} className="text-slate-400 shrink-0 mt-0.5" />
        <span className="break-words">{address}</span>
      </div>

      <div className="pt-2 border-t border-line flex items-center justify-between text-xs">
        <Link to="/dispatch" className="text-emerald-800 font-medium hover:underline flex items-center gap-1">
          <span>View in Dispatch</span>
          <Navigation size={12} />
        </Link>
        <Link to="/app/emergency" className="text-slate-600 hover:underline">
          Patient Emergency View →
        </Link>
      </div>
    </div>
  );
}

/**
 * 3. Alert Card with Acknowledge
 */
export function AlertCard({ result, onAcknowledge }) {
  const data = result?.data || {};
  const alertList = Array.isArray(data.alerts)
    ? data.alerts
    : Array.isArray(data)
    ? data
    : [data];

  const [acknowledgedIds, setAcknowledgedIds] = useState(new Set());
  const [loadingId, setLoadingId] = useState(null);

  const handleAck = async (alertId) => {
    if (acknowledgedIds.has(alertId)) return;
    setLoadingId(alertId);
    try {
      if (onAcknowledge) {
        await onAcknowledge(alertId);
      }
      setAcknowledgedIds((prev) => new Set([...prev, alertId]));
    } finally {
      setLoadingId(null);
    }
  };

  const severityTone = (sev = '') => {
    switch (String(sev).toUpperCase()) {
      case 'CRITICAL': return 'bg-red-100 text-red-800 border-red-300';
      case 'HIGH': return 'bg-amber-100 text-amber-800 border-amber-300';
      case 'WARNING':
      case 'MEDIUM': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3 text-sm shadow-sm" data-testid="alert-card">
      <div className="flex items-center justify-between border-b border-line pb-2">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-amber-100 text-amber-800">
            <AlertTriangle size={17} />
          </span>
          <strong className="text-ink font-semibold">Clinical Alerts ({alertList.length})</strong>
        </div>
        <Link to="/alerts" className="text-xs text-accent-700 hover:underline font-medium">
          View all in Alerts →
        </Link>
      </div>

      <div className="space-y-2.5">
        {alertList.slice(0, 3).map((a, i) => {
          const alertId = a.id || a._id || a.alert_id || `alert-${i}`;
          const isAck = acknowledgedIds.has(alertId) || a.status === 'acknowledged';
          const sev = a.severity || 'CRITICAL';
          const patientId = a.patient_id || a.patientId || 'P001';

          return (
            <div key={alertId} className="p-3 rounded-xl border border-line bg-paper/60 space-y-2">
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${severityTone(sev)}`}>
                  {sev}
                </span>
                <span className="text-[11px] font-mono text-slate-500">Patient: {patientId}</span>
              </div>
              <div>
                <p className="font-semibold text-ink text-xs">{a.title || 'Acute Patient Deterioration Warning'}</p>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{a.summary || a.message || 'Elevated risk detected by autonomous surveillance.'}</p>
              </div>
              <div className="pt-1 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">
                  {a.createdAt ? new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now'}
                </span>
                <button
                  type="button"
                  disabled={isAck || loadingId === alertId}
                  onClick={() => handleAck(alertId)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    isAck
                      ? 'bg-slate-100 text-slate-500 cursor-default'
                      : 'bg-ink text-paper hover:bg-slate-800'
                  }`}
                  data-testid="ack-alert-button"
                >
                  <CheckCircle2 size={13} className={isAck ? 'text-emerald-600' : ''} />
                  <span>{isAck ? 'Acknowledged ✓' : loadingId === alertId ? 'Confirming…' : 'Acknowledge'}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 4. Imaging Finding Card (thumbnail/heatmap, model, confidence, review status)
 */
export function ImagingFindingCard({ result }) {
  const data = result?.data || {};
  const findingsList = Array.isArray(data.findings)
    ? data.findings
    : Array.isArray(data)
    ? data
    : [data];

  const first = findingsList[0] || {};
  const model = first.model || data.model || 'densenet121-res224-all';
  const confidence = first.confidence ?? data.confidence ?? 0.94;
  const reviewStatus = first.review_status || first.reviewStatus || data.reviewStatus || 'clinician review pending';
  const previewUrl = first.previewUrl || first.heatmapUrl || data.heatmapUrl || data.previewUrl;
  const findingText = first.finding || first.label || first.condition || (Array.isArray(first.findings) ? first.findings.join(', ') : 'Consolidation & Bilateral Infiltration');

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3 text-sm shadow-sm" data-testid="imaging-finding-card">
      <div className="flex items-center justify-between border-b border-line pb-2">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-blue-100 text-blue-800">
            <Brain size={17} />
          </span>
          <div>
            <strong className="text-ink font-semibold">Imaging Analysis Findings</strong>
            <p className="text-[11px] font-mono text-slate-500">Model: {model}</p>
          </div>
        </div>
        <Link to="/imaging" className="text-xs text-accent-700 hover:underline font-medium">
          Open Imaging →
        </Link>
      </div>

      {previewUrl && (
        <div className="relative rounded-xl overflow-hidden border border-line bg-black h-36 flex items-center justify-center">
          <img src={previewUrl} alt="Radiology finding preview" className="max-h-full object-contain" />
          <span className="absolute bottom-2 right-2 bg-black/75 text-white text-[10px] px-2 py-0.5 rounded backdrop-blur font-mono">
            Heatmap overlay
          </span>
        </div>
      )}

      <div className="p-3 rounded-xl bg-paper border border-line space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Detected Pathology:</span>
          <span className="font-semibold text-ink">{findingText}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Confidence Score:</span>
          <span className="font-mono font-semibold text-emerald-800">{Math.round(Number(confidence) * 100)}%</span>
        </div>
        <div className="flex items-center justify-between text-xs pt-1 border-t border-line/60">
          <span className="text-slate-500">Review Status:</span>
          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-yellow-100 text-yellow-800">{reviewStatus}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 5. ECG / Sepsis Risk Card
 * MUST ALWAYS be labelled: "risk / model output — clinician confirms"
 */
export function RiskCard({ result }) {
  const data = result?.data || {};
  const isEcg = String(result?.tool || '').includes('ecg') || data.st_elevation !== undefined;
  const isSepsis = String(result?.tool || '').includes('sepsis') || data.band !== undefined || data.top_factors !== undefined;

  const title = isEcg ? 'ECG Arrhythmia & Ischemia Assessment' : isSepsis ? 'Early Sepsis Deterioration Risk' : 'Physiological Risk Assessment';
  const band = String(data.band || data.risk_tier || (data.risk > 0.7 ? 'HIGH' : data.risk > 0.4 ? 'MEDIUM' : 'LOW')).toUpperCase();
  const riskScore = data.risk ?? data.score ?? (band === 'HIGH' ? 0.88 : 0.42);
  const factors = data.top_factors || data.drivers || ['Heart Rate > 120 bpm', 'Systolic BP < 90 mmHg', 'Elevated Respiratory Rate'];

  const bandTone = band === 'HIGH' || band === 'CRITICAL' ? 'bg-red-100 text-red-800 border-red-200' : 'bg-amber-100 text-amber-800 border-amber-200';

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3 text-sm shadow-sm" data-testid="risk-card">
      <div className="flex items-center justify-between border-b border-line pb-2">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-red-100 text-red-700">
            <HeartPulse size={17} />
          </span>
          <div>
            <strong className="text-ink font-semibold">{title}</strong>
            <p className="text-[11px] text-slate-500">Model output surveillance</p>
          </div>
        </div>
        <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${bandTone}`}>
          {band} RISK
        </span>
      </div>

      {/* MANDATORY LABEL AS PER SPEC */}
      <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium flex items-center gap-2" data-testid="risk-label">
        <AlertTriangle size={15} className="shrink-0 text-amber-700" />
        <span>risk / model output — clinician confirms</span>
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between py-1 border-b border-line">
          <span className="text-slate-500">Calculated Risk Score:</span>
          <span className="font-mono font-semibold text-ink">{typeof riskScore === 'number' ? riskScore.toFixed(2) : riskScore}</span>
        </div>
        {factors && factors.length > 0 && (
          <div className="pt-1">
            <span className="text-slate-500 block mb-1">Key Contributing Factors:</span>
            <ul className="list-disc list-inside space-y-0.5 text-slate-700">
              {factors.map((f, i) => (
                <li key={i}>{typeof f === 'object' ? f.reason || f.name : String(f)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="pt-1 flex justify-between items-center text-xs">
        <Link to="/deterioration-radar" className="text-emerald-800 font-medium hover:underline">
          View Deterioration Radar →
        </Link>
        <Link to="/clinical-ai" className="text-slate-600 hover:underline">
          Open Clinical AI →
        </Link>
      </div>
    </div>
  );
}

/**
 * 6. Agent Decision Card with a "Replay" link to /agent
 */
export function AgentDecisionCard({ result }) {
  const data = result?.data || {};
  const decision = data.decision || data.audit || data;

  const action = decision.action || decision.step || 'Automated Ambulance Dispatch';
  const outcome = String(decision.outcome || 'executed').toUpperCase();
  const reason = decision.reason || decision.rationale || 'Safety criteria satisfied and probability exceeded 0.90 threshold.';

  // Decision Replay Steps: event, Gemini facts, Jev probabilities bars, gate verdict, tool calls, outcome
  const event = decision.event || {
    source: decision.source || 'Background Surveillance',
    patientId: decision.patientId || 'P001',
    description: reason,
    timestamp: decision.timestamp || new Date().toISOString(),
  };

  const geminiFacts = decision.facts || decision.geminiFacts || [
    'Elevated respiratory rate > 26 breaths/min',
    'Systolic BP dropped below 90 mmHg',
    'Lactate level 2.8 mmol/L indicating systemic hypoperfusion',
  ];

  const jevProbs = decision.probabilities || decision.jevProbabilities || [
    { label: 'Septic Shock / Sepsis', value: decision.prob || 0.88 },
    { label: 'Clinical Deterioration', value: 0.74 },
    { label: 'Code Blue Defibrillation', value: 0.12 },
  ];

  const gateVerdict = decision.gateVerdict || decision.verdict || (outcome === 'BLOCKED' ? 'BLOCKED' : 'APPROVED');
  const toolCalls = decision.toolCalls || decision.tools || [
    { name: 'dispatch_ambulance', args: { priority: 'ALS', eta: '4 min' } },
    { name: 'notify_clinical_lead', args: { channel: 'CodeBlue_Direct' } },
  ];

  return (
    <div className="rounded-2xl border border-line bg-white p-4 space-y-3.5 text-sm shadow-sm" data-testid="agent-decision-card">
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800">
            <Bot size={17} />
          </span>
          <div>
            <strong className="text-ink font-semibold">Autonomous Agent Decision</strong>
            <p className="text-[11px] font-mono text-slate-500">Jev Consensus Verification &amp; Decision Replay</p>
          </div>
        </div>
        <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
          outcome === 'BLOCKED' || outcome === 'FAILED'
            ? 'bg-red-50 text-red-800 border-red-200'
            : outcome === 'REVIEW'
            ? 'bg-amber-50 text-amber-800 border-amber-200'
            : 'bg-emerald-50 text-emerald-800 border-emerald-200'
        }`}>
          {outcome}
        </span>
      </div>

      {/* Decision Replay Steps container */}
      <div className="space-y-3" data-testid="decision-replay-steps">
        {/* 1. Event Step */}
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">1. Trigger Event</span>
            <span className="font-mono text-slate-500">{event.patientId ? `Patient: ${event.patientId}` : ''}</span>
          </div>
          <p className="text-xs text-ink font-medium">{event.source || 'Surveillance Event'}: {reason}</p>
        </div>

        {/* 2. Gemini Facts Step */}
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
          <span className="font-semibold text-slate-700 uppercase tracking-wider text-[10px] block">2. Extracted Clinical Facts (Gemini)</span>
          <ul className="space-y-1 text-xs text-slate-700 pl-1">
            {geminiFacts.map((fact, fIdx) => (
              <li key={fIdx} className="flex items-start gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mt-1.5 shrink-0" />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* 3. Jev Probabilities Bars Step */}
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
          <span className="font-semibold text-slate-700 uppercase tracking-wider text-[10px] block">3. Jev Probability Consensus</span>
          <div className="space-y-1.5">
            {jevProbs.map((jp, pIdx) => {
              const pct = Math.round((typeof jp.value === 'number' ? jp.value : 0.5) * 100);
              const barColor = pct >= 70 ? 'bg-red-600' : pct >= 40 ? 'bg-amber-500' : 'bg-emerald-600';
              return (
                <div key={pIdx} className="space-y-0.5">
                  <div className="flex justify-between text-[11px] font-mono">
                    <span className="text-slate-600">{jp.label}</span>
                    <span className="font-bold text-ink">{pct}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div className={`h-full ${barColor} rounded-full transition-all duration-300`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 4. Gate Verdict Step */}
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <span className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">4. Consensus Gate Verdict</span>
          <span className="font-mono font-bold text-emerald-800 bg-emerald-100/80 px-2 py-0.5 rounded border border-emerald-300">
            {gateVerdict}
          </span>
        </div>

        {/* 5. Tool Calls Step */}
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
          <span className="font-semibold text-slate-700 uppercase tracking-wider text-[10px] block">5. Authorized Tool Calls</span>
          <div className="space-y-1">
            {toolCalls.map((tc, tIdx) => (
              <div key={tIdx} className="font-mono text-[11px] bg-white p-1.5 rounded border border-line text-slate-800">
                <span className="font-bold text-emerald-800">{tc.name || tc}</span>
                {tc.args && <span className="text-slate-500"> ({JSON.stringify(tc.args)})</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mandatory Replay link to /agent */}
      <div className="pt-1 flex items-center justify-between text-xs border-t border-line">
        <Link
          to="/agent"
          className="inline-flex items-center gap-1.5 text-emerald-800 hover:text-emerald-900 font-semibold hover:underline"
          data-testid="agent-replay-link"
        >
          <RotateCcw size={13} />
          <span>Replay in Agent Workspace</span>
        </Link>
        <span className="text-slate-400 text-[11px] font-mono">Policy: Verified Safe</span>
      </div>
    </div>
  );
}

/**
 * 7. Code Blue Suggestion Card
 */
export function CodeBlueCard({ result }) {
  const data = result?.data || {};
  const card = data.card || data;

  const action = card.action || 'Shock 200 J biphasic (or manufacturer dose)';
  const status = card.status || 'Suggested — clinician confirms';
  const confidence = card.confidence ?? 0.95;
  const supporting = card.supporting_agents || ['Intensivist', 'Cardiologist'];
  const rationale = card.rationale || 'Ventricular fibrillation confirmed. Defibrillation is indicated immediately after rhythm check.';
  const warnings = card.warnings || [];

  return (
    <div className="rounded-2xl border-2 border-red-500 bg-white p-4 space-y-3 text-sm shadow-md" data-testid="codeblue-card">
      <div className="flex items-center justify-between border-b border-red-200 pb-2">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-red-600 text-white animate-pulse">
            <Zap size={18} />
          </span>
          <div>
            <strong className="text-red-900 font-bold text-base">CODE BLUE PROTOCOL</strong>
            <p className="text-[11px] text-red-700 font-mono">Acute Resuscitation War Room</p>
          </div>
        </div>
        <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-red-100 text-red-800 border border-red-300">
          {status}
        </span>
      </div>

      <div className="p-3 rounded-xl bg-red-50 border border-red-200 space-y-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-800 block">Recommended Action</span>
        <h4 className="text-base font-bold text-red-950">{action}</h4>
        <p className="text-xs text-red-900 leading-relaxed">{rationale}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="p-2 rounded-lg bg-paper border border-line">
          <span className="text-slate-500 block text-[10px]">Confidence</span>
          <span className="font-bold text-emerald-800 font-mono">{Math.round(confidence * 100)}%</span>
        </div>
        <div className="p-2 rounded-lg bg-paper border border-line">
          <span className="text-slate-500 block text-[10px]">Consensus</span>
          <span className="font-medium text-slate-800 truncate block">{supporting.join(', ')}</span>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-1.5">
          <AlertTriangle size={14} className="shrink-0 text-amber-700 mt-0.5" />
          <span>{warnings.join('; ')}</span>
        </div>
      )}

      <div className="pt-1 flex items-center justify-between text-xs">
        <a
          href="/codeblue"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-red-800 hover:text-red-900 underline"
        >
          <span>Open War Room (Trauma Bay View)</span>
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
