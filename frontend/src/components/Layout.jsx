import { useMemo } from "react";
import { Link, useLocation, useNavigate, Outlet } from "react-router-dom";
import {
  LayoutDashboard, TrendingUp, Compass, BarChart3, Globe2, Newspaper,
  FileText, Send, Settings as SettingsIcon, Users, Activity, LogOut,
  Radio, ClipboardList, ArrowLeftRight, Search,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import TopTicker from "./TopTicker";

function NavItem({ to, icon: Icon, label, testid }) {
  const loc = useLocation();
  const active = loc.pathname === to || (to !== "/" && loc.pathname.startsWith(to));
  return (
    <Link
      to={to}
      data-testid={testid}
      className="flex items-center gap-3 px-3 py-2 rounded-sm text-[13px] transition-colors"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--surface-elevated)" : "transparent",
        borderLeft: active ? "2px solid var(--text-primary)" : "2px solid transparent",
      }}
    >
      <Icon size={16} strokeWidth={1.8} />
      <span>{label}</span>
    </Link>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";

  const sections = useMemo(() => ([
    {
      title: "Intelligence",
      items: [
        { to: "/", icon: LayoutDashboard, label: "Dashboard", testid: "nav-dashboard" },
        { to: "/ideas", icon: TrendingUp, label: "Trade Ideas", testid: "nav-ideas" },
        { to: "/explorer", icon: Compass, label: "Stock Explorer", testid: "nav-stocks" },
        { to: "/deep-dive", icon: Search, label: "Stock Deep Dive", testid: "nav-deep-dive" },
        { to: "/macro", icon: Globe2, label: "Macro & Sectors", testid: "nav-macro" },
        { to: "/flows", icon: ArrowLeftRight, label: "Flows & Insider", testid: "nav-flows" },
        { to: "/news", icon: Newspaper, label: "News Feed", testid: "nav-news" },
      ],
    },
    {
      title: "Reports",
      items: [
        { to: "/reports", icon: FileText, label: "Report History", testid: "nav-history" },
        { to: "/backtests", icon: BarChart3, label: "Backtests", testid: "nav-backtests" },
        { to: "/deliveries", icon: Send, label: "Delivery Logs", testid: "nav-deliveries" },
      ],
    },
    {
      title: "Account",
      items: [
        { to: "/preferences", icon: SettingsIcon, label: "Preferences", testid: "nav-preferences" },
      ],
    },
    ...(isAdmin ? [{
      title: "Admin",
      items: [
        { to: "/admin/connectors", icon: Radio, label: "Connectors", testid: "nav-admin-connectors" },
        { to: "/admin/settings", icon: SettingsIcon, label: "Settings", testid: "nav-admin-settings" },
        { to: "/admin/users", icon: Users, label: "Users", testid: "nav-admin-users" },
        { to: "/admin/logs", icon: ClipboardList, label: "Audit Logs", testid: "nav-admin-logs" },
      ],
    }] : []),
  ]), [isAdmin]);

  return (
    <div className="min-h-screen flex" style={{ background: "var(--bg)" }}>
      <aside
        className="w-[240px] shrink-0 border-r flex flex-col sticky top-0 h-screen"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="px-5 py-5 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
          <div className="overline">Market Pulse</div>
          <div className="font-heading text-[22px] leading-tight mt-0.5">India</div>
          <div className="mt-3 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            <Activity size={12} strokeWidth={2} color="var(--bullish)" />
            <span className="font-mono">Market Intelligence Engine</span>
          </div>
        </div>

        <nav className="py-3 flex flex-col gap-4 overflow-y-auto flex-1 min-h-0">
          {sections.map((sec) => (
            <div key={sec.title} className="flex flex-col gap-0.5">
              <div className="overline px-5 mb-1">{sec.title}</div>
              <div className="flex flex-col">
                {sec.items.map((it) => <NavItem key={it.to} {...it} />)}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 p-4 border-t" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>Signed in</div>
          <div className="text-[13px] truncate" data-testid="current-user-email">{user?.email}</div>
          <button
            className="btn btn-outline mt-2 w-full justify-center"
            onClick={() => { logout(); navigate("/login"); }}
            data-testid="logout-btn"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <TopTicker />
        <div className="flex-1 overflow-x-hidden fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
