/**
 * Pure state logic for Action Confirmation cards.
 * Ensures actions never auto-confirm and handles transitions.
 */
export const ACTION_TOOL_LABELS = {
  send_sos: 'Emergency Ambulance Request',
  book_appointment: 'Schedule Patient Appointment',
  change_appointment: 'Reschedule / Cancel Appointment',
  log_reading: 'Log Patient Vital Reading',
  create_reminder: 'Prescribe Medication Reminder',
  change_reminder: 'Update Reminder Status',
  edit_reminder: 'Edit Medication Reminder',
  log_dose: 'Record Administered Dose',
  analyze_image: 'Run AI Image Analysis',
  appointment_status: 'Confirm Appointment Status',
  update_profile: 'Update Patient Profile',
  acknowledge_alert: 'Acknowledge Clinical Alert',
  codeblue_start: 'Initiate Code Blue Drill',
};

export function getActionDescription(action) {
  if (!action || !action.tool) return 'Proposed clinical action';
  const toolName = ACTION_TOOL_LABELS[action.tool] || action.tool.replaceAll('_', ' ');
  const args = action.arguments || {};

  switch (action.tool) {
    case 'send_sos':
      return `Dispatch an emergency SOS response unit to ${
        action.location
          ? `${action.location.latitude.toFixed(4)}, ${action.location.longitude.toFixed(4)}`
          : 'verified location'
      }.`;
    case 'create_reminder':
      return `Create a new reminder for ${args.medicationName || 'medication'} (${
        args.dosage || 'prescribed dose'
      }) scheduled at ${Array.isArray(args.times) ? args.times.join(', ') : 'scheduled times'}.`;
    case 'book_appointment':
      return `Submit an appointment request for ${args.doctor || 'physician'} on ${
        args.at || 'specified date'
      } at ${args.location || 'clinic'}.`;
    case 'log_reading':
      return `Record a ${args.type || 'vital'} reading of ${args.value}${
        args.diastolic ? `/${args.diastolic}` : ''
      } for patient record.`;
    case 'change_reminder':
      return `${args.operation || 'Update'} reminder status for reminder ${args.reminderId || ''}.`;
    case 'analyze_image':
      return `Execute neural inference model ${args.model || ''} on image ${args.fileId || ''}.`;
    case 'acknowledge_alert':
      return `Mark alert ${args.alertId || ''} as clinician-reviewed and acknowledged.`;
    case 'codeblue_start':
      return `Activate Code Blue protocol for patient ${args.patientId || 'DEMO-P001'}.`;
    default:
      return `Execute ${toolName} with parameters: ${Object.entries(args)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`;
  }
}

/**
 * Computes next action state based on user decision and API response.
 * CRITICAL SAFETY REQUIREMENT: Never auto-confirm.
 */
export function computeNextActionState(currentState, decision, responseData) {
  if (currentState !== 'pending') return currentState;
  if (decision === 'cancel') return 'cancelled';
  if (decision !== 'approve') return 'pending';
  if (responseData?.result?.cancelled === true) return 'cancelled';
  return 'succeeded';
}
