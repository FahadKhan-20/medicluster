/**
 * Pure state and trace construction logic for the Step Timeline.
 * Separated into pure JS for Node.js native test runner (node --test) compatibility.
 */
export function buildExecutionTrace(agentData, isPending = false) {
  if (!agentData && !isPending) return [];

  const results = agentData?.results || [];
  const actions = agentData?.actions || [];
  const customSteps = agentData?.steps || agentData?.trace || [];

  if (customSteps.length > 0) {
    return customSteps.map((st) => ({
      label: st.label || st.name || st.title || 'Agent Step',
      status: st.status || 'completed',
      detail: st.detail || st.description || (st.args ? JSON.stringify(st.args) : ''),
    }));
  }

  const steps = [];

  // Step 1: Understanding request
  steps.push({
    id: 'understanding',
    label: 'Understanding request',
    status: 'completed',
    detail: 'Intent and parameters parsed',
  });

  // Step 2..N: Tool calls
  for (const r of results) {
    const toolName = r.tool || 'clinical_tool';
    let detail = '';

    if (r.error) {
      steps.push({
        id: `tool-${toolName}`,
        label: `Calling tool ${toolName}`,
        status: 'error',
        detail: `Error: ${r.error}`,
      });
      continue;
    }

    const d = r.data || {};
    if (d.ambulances || Array.isArray(d)) {
      const count = Array.isArray(d.ambulances) ? d.ambulances.length : Array.isArray(d) ? d.length : 0;
      detail = `Result: ${count} ambulance unit${count === 1 ? '' : 's'} located`;
    } else if (d.alerts || d.alert) {
      detail = 'Result: Alert status retrieved & verified';
    } else if (d.findings) {
      detail = 'Result: Neural imaging findings extracted';
    } else if (d.risk !== undefined || d.score !== undefined) {
      detail = 'Result: Physiological risk computed';
    } else if (d.matches) {
      detail = `Result: ${d.matches.length} patient match${d.matches.length === 1 ? '' : 'es'} found`;
    } else if (d.hospitals) {
      detail = `Result: ${d.hospitals.length} nearby hospital facilities retrieved`;
    } else if (d.action || d.card || d.decision) {
      detail = 'Result: Decision consensus verified';
    } else {
      detail = 'Result: Data retrieved and verified';
    }

    steps.push({
      id: `tool-${toolName}`,
      label: `Calling tool ${toolName}`,
      status: 'completed',
      detail,
    });
  }

  // Pending action step
  if (actions.length > 0) {
    steps.push({
      id: 'action-confirm',
      label: 'Needs your confirmation',
      status: 'pending',
      detail: `${actions.length} action requires clinician approval`,
    });
  }

  // Done step
  steps.push({
    id: 'done',
    label: 'Done',
    status: actions.length > 0 ? 'pending' : 'completed',
    detail: actions.length > 0 ? 'Awaiting user decision' : 'Response finalized',
  });

  return steps;
}
