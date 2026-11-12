/** Short, readable incident reference for tight lists: "PAT-2aec6905…" → "#2AEC69". */
export function shortIncidentId(id) {
  if (!id) return '';
  const value = String(id);
  if (value.length <= 10) return `#${value.toUpperCase()}`;
  const body = value.replace(/^[A-Za-z]+-/, '').replace(/[^A-Za-z0-9]/g, '');
  return `#${body.slice(0, 6).toUpperCase()}`;
}
