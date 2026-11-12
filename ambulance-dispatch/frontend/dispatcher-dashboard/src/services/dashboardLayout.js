/* Column widths and saved open/closed state for the dashboard's two side panels. */
export const RAIL_WIDTH = 44;
const KEY = 'dispatch.panels';
const WIDTHS = { lg: [300, 310], xl: [330, 330] };
const DEFAULT = { left: true, right: true };

export function dashboardColumns({ left, right }) {
  const cols = ([l, r]) => `${left ? l : RAIL_WIDTH}px minmax(0,1fr) ${right ? r : RAIL_WIDTH}px`;
  return { lg: cols(WIDTHS.lg), xl: cols(WIDTHS.xl) };
}

export function readPanels(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (saved && typeof saved.left === 'boolean' && typeof saved.right === 'boolean') return { left: saved.left, right: saved.right };
  } catch { /* fall back to defaults */ }
  return { ...DEFAULT };
}

export function savePanels(storage, panels) {
  try { storage?.setItem(KEY, JSON.stringify({ left: !!panels.left, right: !!panels.right })); } catch { /* storage full or blocked */ }
}
