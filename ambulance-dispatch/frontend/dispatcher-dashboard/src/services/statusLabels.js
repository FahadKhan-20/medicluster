// Unified status mappings across dispatcher, crew, and patient apps.

export const STATUS_LABELS = {
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  EN_ROUTE_TO_SCENE: 'En Route',
  EN_ROUTE: 'En Route',
  ON_SCENE: 'On Scene',
  TRANSPORTING_TO_HOSPITAL: 'Transporting',
  TRANSPORTING: 'Transporting',
  ARRIVED_AT_HOSPITAL: 'At Hospital',
  AT_HOSPITAL: 'At Hospital',
  RETURNING_TO_BASE: 'Returning',
  RETURNING: 'Returning',
  AVAILABLE: 'Available',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
  MAINTENANCE: 'Maintenance',
  OFFLINE: 'Offline',
  OFF_DUTY: 'Off Duty',
};

export function getStatusLabel(status) {
  if (!status) return 'Unknown';
  return STATUS_LABELS[status] || STATUS_LABELS[String(status).toUpperCase()] || String(status).replace(/_/g, ' ');
}

export function statusToStage(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ASSIGNED':
    case 'EN_ROUTE_TO_SCENE':
    case 'EN_ROUTE':
      return 1;
    case 'ON_SCENE':
      return 2;
    case 'TRANSPORTING_TO_HOSPITAL':
    case 'TRANSPORTING':
      return 3;
    case 'ARRIVED_AT_HOSPITAL':
    case 'AT_HOSPITAL':
      return 4;
    default:
      return 1;
  }
}
