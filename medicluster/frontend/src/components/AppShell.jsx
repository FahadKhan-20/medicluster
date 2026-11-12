import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { getMlHealth } from "../api/apiClient";
import { NAV_GROUPS, NAV_ITEMS, isActive } from "../navigation";
import Logo from "./Logo";
import { Bell, ChartNoAxesCombined, ScanLine, Brain, Activity, Users, CalendarClock, FileText, MessageCircle, Sparkles, Hospital, Radio, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X, Bot } from "lucide-react";
import FloatingChatLauncher from "../chat/FloatingChatLauncher";

const NAV_ICONS = { Alerts: Bell, Dashboard: ChartNoAxesCombined, Imaging: ScanLine, "3D Tumor Explorer": Brain, "Deterioration Radar": Activity, Patients: Users, Reminders: CalendarClock, Reports: FileText, CliniQ: MessageCircle, "Clinical AI": Sparkles, Agent: Bot, Hospitals: Hospital, Dispatch: Radio };

const ML_POLL_MS = 30_000;

function NavItem({ item, active }) {
  const Icon = NAV_ICONS[item.label] || Activity;
  const cls = `mc-nav-link flex items-center gap-2 w-full h-[30px] px-2 rounded-sm text-[13.5px] text-left ${
    active ? "bg-ink text-paper font-medium" : "text-ink hover:bg-sunken"
  }`;
  const body = (
    <>
      <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
      {item.label}
    </>
  );
  return item.href
    ? <a href={item.href} className={cls}>{body}</a>
    : <Link to={item.to} className={cls} aria-current={active ? "page" : undefined}>{body}</Link>;
}

function MlStatus() {
  const [online, setOnline] = useState(null);

  useEffect(() => {
    let alive = true;
    const check = () => getMlHealth()
      .then((r) => alive && setOnline(r.online))
      .catch(() => alive && setOnline(false));
    check();
    const id = setInterval(check, ML_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const color = online == null ? "bg-slate-300" : online ? "bg-risk-low" : "bg-risk-critical";
  const label = online == null ? "checking" : online ? "online" : "offline";
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-slate-600">
      <span className={`w-1.5 h-1.5 ${color}`} aria-hidden="true" />ML engine · {label}
    </div>
  );
}

export default function AppShell({ children }) {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarClosed, setSidebarClosed] = useState(() => {
    try { return localStorage.getItem("mc_sidebar_closed") === "true"; }
    catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("mc_sidebar_closed", String(sidebarClosed)); }
    catch { /* Navigation still works when browser storage is unavailable. */ }
  }, [sidebarClosed]);

  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className={`mc-workspace ${sidebarClosed ? "mc-sidebar-closed" : ""} min-h-screen grid min-[860px]:grid-cols-[216px_minmax(0,1fr)] bg-paper text-ink`}>
      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-black/35 min-[860px]:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-[260px] transition-transform duration-200 ${menuOpen ? "translate-x-0" : "-translate-x-full"}
          min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-screen min-[860px]:w-auto min-[860px]:translate-x-0 min-[860px]:transition-none
          flex flex-col gap-7 px-3.5 pt-[22px] pb-[18px] border-r border-line bg-paper overflow-auto`}
      >
        <div className="mc-sidebar-heading">
        <Link to="/" className="flex items-center gap-[9px] text-ink min-w-0">
          <Logo className="w-[18px] h-[18px]" />
          <span className="font-serif text-[21px] tracking-[-0.01em]">MediCluster</span>
        </Link>
        <button type="button" className="mc-sidebar-toggle mc-sidebar-desktop-toggle" aria-label="Close sidebar" aria-expanded="true" aria-controls="app-sidebar" title="Close sidebar" onClick={() => setSidebarClosed(true)}><PanelLeftClose size={19} aria-hidden="true" /></button>
        <button type="button" className="mc-sidebar-toggle min-[860px]:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}><X size={19} aria-hidden="true" /></button>
        </div>

        <nav className="flex flex-col gap-5" aria-label="Main">
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="flex flex-col gap-px">
              <div className="mc-nav-group-label px-2 pb-1.5 font-mono text-[10.5px] tracking-[0.08em] uppercase text-slate-500">{g.label}</div>
              {NAV_ITEMS.filter((i) => i.group === g.label).map((item) => (
                <NavItem key={item.label} item={item} active={!!item.to && isActive(item.to, pathname)} />
              ))}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2.5 px-2 pt-3.5 border-t border-line">
          <MlStatus />
          <div className="flex items-end justify-between gap-2">
            <div className="flex flex-col leading-snug min-w-0">
              <span className="font-medium text-[13px] truncate" title={user?.email}>{user?.name}</span>
              <span className="text-xs text-slate-500 truncate">{user?.department}</span>
            </div>
            <button type="button" onClick={logout} className="text-xs text-slate-500 hover:text-ink shrink-0">Sign out</button>
          </div>
        </div>
      </aside>

      <div className="mc-workspace-body min-w-0 flex flex-col">
        {sidebarClosed && <button type="button" className="mc-sidebar-toggle mc-sidebar-reopen" aria-label="Open sidebar" aria-expanded="false" aria-controls="app-sidebar" title="Open sidebar" onClick={() => setSidebarClosed(false)}><PanelLeftOpen size={20} aria-hidden="true" /></button>}
        <button type="button" className="mc-mobile-menu" onClick={() => setMenuOpen(o => !o)} aria-label={menuOpen ? "Close" : "Menu"} aria-expanded={menuOpen} aria-controls="app-sidebar"><MenuIcon size={20} aria-hidden="true" /></button>
        <main className="mc-workspace-main flex-1 min-w-0">{children}</main>
        <FloatingChatLauncher />
      </div>
    </div>
  );
}
