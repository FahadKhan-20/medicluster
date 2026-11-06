/**
 * Turns the crew ambulance row's `assigned_incident_id` (set in the database by
 * dispatch_assign) into one incoming call. This works across devices, unlike the
 * tab-to-tab dispatchBroadcast channel.
 */
export function createAssignmentWatcher({ fetchIncident, onCall }) {
  let handled = null;   // incident id already rung or already on screen
  let pending = null;   // incident id being read
  let stopped = false;

  return {
    update({ vehicleId, assignedIncidentId, activeIncidentId = null }) {
      if (stopped) return;
      if (!assignedIncidentId) { handled = null; pending = null; return; }
      if (!vehicleId) return;
      if (assignedIncidentId === activeIncidentId) { handled = assignedIncidentId; return; }
      if (assignedIncidentId === handled || assignedIncidentId === pending) return;

      const id = assignedIncidentId;
      pending = id;
      Promise.resolve()
        .then(() => fetchIncident(id))
        .then((incident) => {
          if (stopped || pending !== id) return;
          pending = null;
          if (!incident) return;
          if (incident.assigned_ambulance_id !== vehicleId || incident.status !== 'ASSIGNED') { handled = id; return; }
          // onCall returns false when the crew can't take a call yet; retry on the next update.
          if (onCall({ ...incident, _isAssignment: true, ambulance: { id: vehicleId } }) !== false) handled = id;
        })
        .catch(() => { if (pending === id) pending = null; });   // retried on the next update
    },
    stop() { stopped = true; pending = null; },
  };
}
