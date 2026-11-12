// Unified status mappings across dispatcher, crew, and patient apps.

export const STATUS_LABELS = {
  PENDING: 'Waiting for dispatch',
  ASSIGNED: 'Ambulance assigned',
  EN_ROUTE_TO_SCENE: 'Ambulance is on the way',
  EN_ROUTE: 'Ambulance is on the way',
  ON_SCENE: 'Crew has arrived',
  TRANSPORTING_TO_HOSPITAL: 'On the way to hospital',
  TRANSPORTING: 'On the way to hospital',
  ARRIVED_AT_HOSPITAL: 'Arrived at hospital',
  AT_HOSPITAL: 'Arrived at hospital',
  RETURNING_TO_BASE: 'Returning to base',
  RETURNING: 'Returning to base',
  AVAILABLE: 'Available',
  RESOLVED: 'Response completed',
  CANCELLED: 'Request cancelled',
};

export function getStatusLabel(status) {
  if (!status) return 'Unknown';
  return STATUS_LABELS[status] || STATUS_LABELS[String(status).toUpperCase()] || String(status).replace(/_/g, ' ');
}
