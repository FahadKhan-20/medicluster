/**
 * Pure logic for identifying card type from CliniQ tool result shape and/or tool name.
 * Separated into pure JS for Node native test runner (node --test) compatibility.
 */
export function identifyResultCard(result) {
  if (!result || typeof result !== 'object') return 'generic';
  const tool = String(result.tool || '').toLowerCase();
  const data = result.data;
  if (!data || data.pending) return 'generic';

  // 1. Ambulance List
  if (
    ['ambulances', 'nearby_ambulances', 'find_ambulances', 'ambulance_list', 'dispatch_ambulances'].includes(tool) ||
    data.ambulances ||
    (Array.isArray(data) && data.length > 0 && (data[0]?.ambulance_id || data[0]?.license_plate || data[0]?.vehicle_number || data[0]?.callsign))
  ) {
    return 'ambulance_list';
  }

  // 2. Emergency Tracking
  if (
    ['send_sos', 'emergency_status', 'track_emergency', 'emergency', 'incident_status'].includes(tool) ||
    data.emergency ||
    data.incident ||
    data.incidentId ||
    data.incident_id ||
    (data.status && data.isSos !== undefined) ||
    (data.stage && ['REPORTED', 'DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'ARRIVED', 'RESOLVED'].includes(String(data.status || data.stage).toUpperCase()))
  ) {
    return 'emergency_tracking';
  }

  // 3. Alerts
  if (
    ['alerts', 'list_alerts', 'get_alerts', 'critical_alerts', 'patient_alerts'].includes(tool) ||
    data.alerts ||
    (Array.isArray(data) && data.length > 0 && (data[0]?.severity || data[0]?.alert_id || data[0]?.audit_id)) ||
    (data.severity && (data.title || data.summary))
  ) {
    return 'alert';
  }

  // 4. Imaging Findings
  if (
    ['imaging_records', 'analyze_image', 'imaging_action', 'imaging_summary', 'chest_xray', 'brain_mri'].includes(tool) ||
    data.findings ||
    data.heatmapUrl ||
    data.previewUrl ||
    (data.model && (data.confidence !== undefined || data.findings !== undefined || data.review_status !== undefined)) ||
    (data.fileId && (data.findings || data.model))
  ) {
    return 'imaging_finding';
  }

  // 5. Code Blue Suggestion
  if (
    ['codeblue_start', 'codeblue_suggest', 'codeblue', 'resuscitation'].includes(tool) ||
    (data.card && (data.card.action || data.card.supporting_agents)) ||
    (data.action && (data.supporting_agents || data.action.toLowerCase().includes('shock') || data.action.toLowerCase().includes('defibrillation') || data.action.toLowerCase().includes('cpr')))
  ) {
    return 'codeblue';
  }

  // 6. ECG / Sepsis Risk
  if (
    ['ecg_analyze', 'sepsis_score', 'ecg_risk', 'sepsis_risk', 'clinical_analysis', 'sepsis'].includes(tool) ||
    data.sepsis ||
    data.ecg ||
    (data.risk !== undefined && (data.band || data.top_factors || data.model)) ||
    data.st_elevation !== undefined ||
    (data.heart_rate !== undefined && data.systolic_bp !== undefined && data.temperature !== undefined)
  ) {
    return 'risk';
  }

  // 7. Agent Decision
  if (
    [
      'agent_decision',
      'agent_audits',
      'jev_decision',
      'audit_record',
      'agent_state',
      'explain_agent_decision',
      'agent_recent_decisions',
    ].includes(tool) ||
    data.decision ||
    data.audit ||
    (data.action && data.outcome && data.confidence !== undefined)
  ) {
    return 'agent_decision';
  }

  return 'generic';
}
