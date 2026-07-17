import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { RefreshCw, Zap, FileDown } from "lucide-react";
import api from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCached, invalidate } from "../lib/cache";
import { fmtNum, fmtPct, pctColor, directionBadge, fmtRupee } from "../lib/fmt";
import { SkeletonCard, SkeletonList, SkeletonParagraph, ShimmerLine } from "../components/SkeletonBits";
import FunnelWidget from "../components/FunnelWidget";

export default function Dashboard() {
  const { user } = useAuth();
  const [generating, setGenerating] = useState(false);

  const {
    data: latest, loading: latestLoading, refetch: refetchLatest,
  } = useCached("dashboard:latest", () => api.get("/reports/latest").then((r) => r.data));
  const {
    data: ideas = [], loading: ideasLoading, refetch: refetchIdeas,
  } = useCached("dashboard:ideas", () => api.get("/ideas", { params: { limit: 8 } }).then((r) => r.data));
  const {
    data: sectors = [], loading: sectorsLoading, refetch: refetchSectors,
  } = useCached("dashboard:sectors", () => api.get("/macro/sectors").then((r) => r.data));

  const refreshAll = () => { refetchLatest(); refetchIdeas(); refetchSectors(); };

  const generate = async () => {
    setGenerating(true);
    const startedAtLatest = latest?.id || null;
    try {
      await api.post("/reports/run");
      toast.info("GitHub workflow queued - polling every 15s...", { duration: 5000 });
      const deadline = Date.now() + 15 * 60 * 1000;
      const tick = async () => {
        try {
          const { data } = await api.get("/reports/latest");
          const gotNew = data?.id && data.id !== startedAtLatest;
          if (gotNew && data.status === "success") {
            toast.success(`Report ready — ${data.run_date}. Telegram + email dispatched.`);
            // blow away caches so every page sees the new run
            invalidate("dashboard:latest");
            invalidate("dashboard:ideas");
            invalidate("dashboard:sectors");
            refreshAll();
            setGenerating(false);
            return;
          }
          if (gotNew && data.status === "failed") {
            toast.error(`Report failed: ${data.error || "unknown error"}`);
            setGenerating(false);
            return;
          }
        } catch (err) { console.debug("[dashboard] poll transient error", err); }
        if (Date.now() < deadline) setTimeout(tick, 15000);
        else { toast.warning("Still running — check Report History shortly."); setGenerating(false); refreshAll(); }
      };
      setTimeout(tick, 15000);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to trigger report");
      setGenerating(false);
    }
  };

  // latest==undefined -> still loading; latest==null -> endpoint said no report
  const isEmpty = latest && latest.status === "empty";
  const macro = latest?.macro_snapshot || {};
  const showSkeletons = latestLoading && latest === undefined;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-6">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="overline">Morning brief</div>
          <h1 className="font-heading text-3xl md:text-4xl">Market Dashboard</h1>
          <div className="text-[12px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            {showSkeletons
              ? <span className="inline-block"><ShimmerLine w={180} h={11} /></span>
              : latest?.run_date ? `Last run · ${latest.run_date} IST` : "No report generated yet"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-outline" onClick={refreshAll} data-testid="refresh-dashboard-btn"><RefreshCw size={14} /> Refresh</button>
          {user?.role === "admin" && (
            <button className="btn btn-primary" onClick={generate} disabled={generating} data-testid="generate-report-btn">
              <Zap size={14} /> {generating ? "Starting…" : "Generate Report Now"}
            </button>
          )}
        </div>
      </header>

      {isEmpty ? (
        <div className="panel p-10 text-center" data-testid="empty-report">
          <div className="overline">No report yet</div>
          <div className="font-heading text-2xl mt-2">Generate your first daily brief</div>
          <p className="text-[13px] mt-2 max-w-xl mx-auto" style={{ color: "var(--text-secondary)" }}>
            The scheduler runs automatically at 07:00 IST every day. You can also generate an ad-hoc
            brief from this terminal.
          </p>
          {user?.role === "admin" && (
            <button className="btn btn-primary mt-4 mx-auto" onClick={generate} disabled={generating} data-testid="empty-generate-btn">
              <Zap size={14} /> {generating ? "Starting…" : "Run the engine"}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <section className="panel p-5 lg:col-span-8" data-testid="macro-summary">
            <div className="overline mb-3">Macro Snapshot</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {showSkeletons
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
                : ["NIFTY","BANKNIFTY","INDIAVIX","USDINR","SP500","DXY","CRUDE","GOLD"].map((k) => {
                    const row = macro[k];
                    return (
                      <div key={k} className="panel-elevated p-3">
                        <div className="overline">{k}</div>
                        <div className="font-mono text-[18px] mt-1">{row ? fmtNum(row.last) : "—"}</div>
                        <div className="font-mono text-[11px]" style={{ color: pctColor(row?.change_pct) }}>
                          {row ? fmtPct(row.change_pct) : ""}
                        </div>
                      </div>
                    );
                  })}
            </div>
          </section>

          <section className="panel p-5 lg:col-span-4" data-testid="sector-heatmap">            <div className="overline mb-3">Sector Breadth · 1M</div>
            {sectorsLoading && sectors.length === 0 ? (
              <SkeletonList rows={8} height={18} />
            ) : (
              <div className="flex flex-col gap-1.5">
                {sectors.slice(0, 10).map((s) => (
                  <div key={s.sector} className="flex items-center justify-between text-[12.5px]">
                    <span>{s.sector}</span>
                    <span className="font-mono" style={{ color: pctColor(s.month_pct) }}>{fmtPct(s.month_pct)}</span>
                  </div>
                ))}
                {sectors.length === 0 && <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No sector data yet</div>}
              </div>
            )}
          </section>

          <div className="lg:col-span-12">
            <FunnelWidget funnel={latest?.summary?.funnel || latest?.funnel} reportId={latest?.id} />
          </div>

          <section className="panel p-5 lg:col-span-8" data-testid="report-narrative">
            <div className="overline mb-3">Strategist Note</div>            {showSkeletons ? (
              <SkeletonParagraph lines={6} />
            ) : latest?.narrative ? (
              <>
                <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-primary)" }}>
                  {latest.narrative}
                </div>
                <div className="mt-4">
                  <Link className="btn btn-outline" to={`/reports/${latest.id}`} data-testid="open-report-btn">
                    <FileDown size={14} /> Full report
                  </Link>
                </div>
              </>
            ) : (
              <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No strategist note yet.</div>
            )}
          </section>

          <section className="panel p-5 lg:col-span-4" data-testid="top-ideas">
            <div className="overline mb-3">Top Trade Ideas</div>
            {ideasLoading && ideas.length === 0 ? (
              <SkeletonList rows={6} height={36} />
            ) : (
              <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
                {ideas.slice(0, 7).map((i) => (
                  <Link to={`/explorer/${i.symbol}`} key={i.id} className="py-2 flex items-center justify-between gap-3 hover:bg-[var(--surface-elevated)] px-1 -mx-1">
                    <div>
                      <div className="font-mono text-[13px]">{i.symbol}</div>
                      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{i.sector} · {i.horizon}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={directionBadge(i.direction)}>{i.direction}</span>
                      <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {fmtRupee(i.entry_low)}–{fmtRupee(i.entry_high).replace("₹","")}
                      </span>
                    </div>
                  </Link>
                ))}
                {ideas.length === 0 && <div className="text-[12px] py-4" style={{ color: "var(--text-muted)" }}>No ideas yet.</div>}
              </div>
            )}
            <Link to="/ideas" className="btn btn-ghost mt-2" data-testid="all-ideas-link">All ideas →</Link>
          </section>
        </div>
      )}
    </div>
  );
}
