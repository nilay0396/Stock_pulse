import { useEffect, useMemo, useState } from "react";
import { Filter, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import api from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/fmt";
import StatusDot from "../components/StatusDot";
import { SkeletonTableRows } from "../components/SkeletonBits";

function Stat({ label, value }) {
  return (
    <div className="panel p-4">
      <div className="overline">{label}</div>
      <div className="font-heading text-2xl mt-1">{value}</div>
    </div>
  );
}

function pct(value) {
  const n = Number(value || 0);
  return `${n.toFixed(2)}%`;
}

export default function Backtests() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedReport, setSelectedReport] = useState("");
  const [selectedRun, setSelectedRun] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [candidateFilter, setCandidateFilter] = useState("has_ideas");
  const [dateFilter, setDateFilter] = useState("all");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [reportsRes, runsRes, perfRes] = await Promise.allSettled([
        api.get("/backtests/candidates", { params: { limit: 100 } }),
        api.get("/backtests/runs", { params: { limit: 50 } }),
        api.get("/ideas/performance"),
      ]);
      const failures = [reportsRes, runsRes, perfRes].filter((res) => res.status === "rejected");
      if (failures.length) {
        setError(failures[0].reason?.response?.data?.detail || failures[0].reason?.message || "Some backtest data failed to load.");
      }
      const candidates = reportsRes.status === "fulfilled" ? reportsRes.value.data || [] : [];
      const runRows = runsRes.status === "fulfilled" ? runsRes.value.data || [] : [];
      setReports(candidates);
      setRuns(runRows);
      setPerformance(perfRes.status === "fulfilled" ? perfRes.value.data || null : null);
      if (!selectedReport && candidates.length) {
        const preferred = candidates.find((r) => r.ready) || candidates.find((r) => Number(r.idea_count || 0) > 0) || candidates[0];
        setSelectedReport(preferred.id);
      }
      if (!selectedRun && runRows[0]?.id) await openRun(runRows[0].id);
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "Backtest data failed to load.");
    } finally {
      setLoading(false);
    }
  }

  async function openRun(id) {
    try {
      const res = await api.get(`/backtests/runs/${id}`);
      setSelectedRun(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load backtest run");
    }
  }

  async function runBacktest() {
    if (!selectedReport) return;
    setRunning(true);
    try {
      const res = await api.post(`/backtests/run/${selectedReport}`);
      toast.success("Backtest completed");
      setSelectedRun(res.data);
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Backtest failed");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = selectedRun?.summary || {};
  const trades = selectedRun?.trades || [];
  const selectedReportMeta = useMemo(
    () => reports.find((r) => r.id === selectedReport),
    [reports, selectedReport],
  );
  const reportDates = useMemo(
    () => [...new Set(reports.map((r) => r.run_date).filter(Boolean))],
    [reports],
  );
  const visibleReports = useMemo(() => reports.filter((r) => {
    if (dateFilter !== "all" && r.run_date !== dateFilter) return false;
    if (candidateFilter === "ready") return Boolean(r.ready);
    if (candidateFilter === "has_ideas") return Number(r.idea_count || 0) > 0;
    if (candidateFilter === "no_ideas") return Number(r.idea_count || 0) === 0;
    return true;
  }), [reports, candidateFilter, dateFilter]);
  const selectedReady = Boolean(selectedReportMeta?.ready);
  const isAdmin = user?.role === "admin";
  const runDisabledReason = !selectedReport
    ? "Select a report"
    : !selectedReportMeta
      ? "Selected report is outside the current filter"
      : !isAdmin
        ? "Admin only"
        : !selectedReady
          ? Number(selectedReportMeta.idea_count || 0) === 0
            ? "No ideas to test"
            : `Ready on ${selectedReportMeta.next_ready_on || selectedReportMeta.ready_on || "-"}`
          : "";

  useEffect(() => {
    if (!visibleReports.length) {
      if (selectedReport) setSelectedReport("");
      return;
    }
    if (!visibleReports.some((r) => r.id === selectedReport)) {
      const preferred = visibleReports.find((r) => r.ready) || visibleReports[0];
      setSelectedReport(preferred.id);
    }
  }, [visibleReports, selectedReport]);

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <div className="overline">Validation</div>
          <h1 className="font-heading text-3xl">Backtests</h1>
          <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
            Replay historical report ideas against forward daily candles.
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="flex gap-2">
            <select className="input" value={candidateFilter} onChange={(e) => setCandidateFilter(e.target.value)} aria-label="Candidate filter">
              <option value="has_ideas">Has ideas</option>
              <option value="ready">Ready</option>
              <option value="all">All reports</option>
              <option value="no_ideas">No ideas</option>
            </select>
            <select className="input" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} aria-label="Report date filter">
              <option value="all">All dates</option>
              {reportDates.map((date) => <option key={date} value={date}>{date}</option>)}
            </select>
          </div>
          <select
            className="input min-w-[280px]"
            value={selectedReport}
            onChange={(e) => setSelectedReport(e.target.value)}
            aria-label="Report run"
          >
            {visibleReports.map((r) => (
              <option key={r.id} value={r.id}>
                {reportOptionLabel(r)}
              </option>
            ))}
            {!visibleReports.length && <option value="">No reports match</option>}
          </select>
          <button className="btn btn-primary" onClick={runBacktest} disabled={!selectedReport || !selectedReady || !isAdmin || running}>
            {running ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
            {running ? "Running" : runDisabledReason || "Run Backtest"}
          </button>
        </div>
      </header>

      {error && (
        <section className="panel p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--bearish)" }}>
            <Filter size={15} />
            <span>{error}</span>
          </div>
          <button className="btn btn-outline" onClick={load}>Retry</button>
        </section>
      )}

      {selectedReportMeta && (
        <section className="panel p-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="overline">Selected Report</div>
              <div className="font-heading text-xl mt-1">
                {selectedReportMeta.run_date} - {(selectedReportMeta.id || "").slice(0, 8)}
              </div>
              <div className="font-mono text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
                {Number(selectedReportMeta.idea_count || 0)} ideas - {Number(selectedReportMeta.mature_idea_count || 0)} mature - {Number(selectedReportMeta.pending_idea_count || 0)} pending
              </div>
            </div>
            <div className="font-mono text-[12px]" style={{ color: selectedReady ? "var(--bullish)" : "var(--text-muted)" }}>
              {selectedReady
                ? "Ready to run"
                : Number(selectedReportMeta.idea_count || 0) === 0
                  ? "No ideas in this report"
                  : `Ready on ${selectedReportMeta.next_ready_on || selectedReportMeta.ready_on || "-"}`}
            </div>
          </div>
        </section>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Closed" value={summary.closed ?? 0} />
        <Stat label="Hit Rate" value={pct(summary.hit_rate_pct)} />
        <Stat label="Avg Return" value={pct(summary.avg_return_pct)} />
        <Stat label="Targets" value={summary.targets ?? 0} />
        <Stat label="No Data" value={summary.no_data ?? 0} />
      </div>

      <section className="panel p-5" data-testid="recommendation-performance">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="overline">Live Recommendation Performance</div>
            <div className="font-heading text-xl mt-1">Lifecycle Outcomes</div>
          </div>
          <div className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
            {performance?.closed || 0} closed of {performance?.total || 0} resolved samples
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
          <Stat label="Hit Rate" value={pct(performance?.hit_rate_pct)} />
          <Stat label="Avg Return" value={pct(performance?.avg_return_pct)} />
          <Stat label="Targets" value={performance?.hit_target || 0} />
          <Stat label="Stops" value={performance?.hit_stop || 0} />
          <Stat label="No Entry" value={performance?.no_entry || 0} />
        </div>
        <div className="grid md:grid-cols-3 gap-4 mt-4">
          <PerfBucket title="By Horizon" rows={performance?.by_horizon || []} />
          <PerfBucket title="By Direction" rows={performance?.by_direction || []} />
          <PerfBucket title="Top Sectors" rows={(performance?.by_sector || []).slice(0, 8)} />
          <PerfBucket title="By Setup" rows={performance?.by_setup || []} />
          <PerfBucket title="By Regime" rows={performance?.by_market_regime || []} />
          <PerfBucket title="AI Confidence" rows={performance?.by_ai_confidence || []} />
          <AttributionBucket title="Profit Factors" rows={performance?.top_profit_factors || []} />
          <AttributionBucket title="Loss Factors" rows={performance?.top_loss_factors || []} />
        </div>
      </section>

      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        <div className="panel overflow-hidden">
          <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
            <div className="overline">Runs</div>
            <div className="font-heading text-xl mt-1">Backtest History</div>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-[12px]" style={{ color: "var(--text-muted)" }}>Loading...</div>
            ) : runs.length === 0 ? (
              <div className="p-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
                No backtests yet. Pick a report and run one.
              </div>
            ) : runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className="w-full text-left px-4 py-3 border-b"
                style={{
                  borderColor: "var(--border)",
                  background: selectedRun?.id === run.id ? "var(--surface-elevated)" : "transparent",
                }}
                onClick={() => openRun(run.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-heading text-[15px]">{run.run_date || "Unknown date"}</span>
                  <StatusDot status={run.status} />
                </div>
                <div className="font-mono text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
                  {(run.report_run_id || "").slice(0, 8)} - {fmtDate(run.created_at)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="panel overflow-x-auto">
          <div className="p-4 border-b flex items-center justify-between gap-3" style={{ borderColor: "var(--border)" }}>
            <div>
              <div className="overline">Trades</div>
              <div className="font-heading text-xl mt-1">
                {selectedRun ? `${selectedRun.trades_count || trades.length} Ideas Tested` : "No Backtest Selected"}
              </div>
              {selectedReportMeta && (
                <div className="font-mono text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
                  Selected report: {selectedReportMeta.run_date} - {(selectedReportMeta.id || "").slice(0, 8)}
                </div>
              )}
            </div>
          </div>
          <table className="w-full data-table">
            <thead>
              <tr>
                <th>Symbol</th><th>Horizon</th><th>Outcome</th><th>Entry</th><th>Exit</th><th>Return</th><th>Days</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <SkeletonTableRows cols={7} rows={8} /> : trades.map((trade) => (
                <tr key={trade.id || `${trade.symbol}-${trade.trade_idea_id}`}>
                  <td>
                    <div className="font-heading text-[14px]">{trade.symbol}</div>
                    <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{trade.name || trade.sector || ""}</div>
                  </td>
                  <td>{trade.horizon || "-"}</td>
                  <td><StatusDot status={trade.outcome === "hit_target" ? "success" : trade.outcome === "hit_stop" ? "failed" : "running"} /> <span className="ml-2">{trade.outcome}</span></td>
                  <td>{trade.entry_price ? `${trade.entry_price} (${trade.entry_date || "-"})` : "-"}</td>
                  <td>{trade.exit_price ? `${trade.exit_price} (${trade.exit_date || "-"})` : "-"}</td>
                  <td className="numeric" style={{ color: Number(trade.return_pct || 0) >= 0 ? "var(--bullish)" : "var(--bearish)" }}>{trade.return_pct == null ? "-" : pct(trade.return_pct)}</td>
                  <td>{trade.holding_days ?? "-"}</td>
                </tr>
              ))}
              {!loading && trades.length === 0 && (
                <tr><td colSpan={7} className="text-center py-10" style={{ color: "var(--text-muted)" }}>No trade-level backtest rows selected.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function reportOptionLabel(r) {
  const id = (r.id || "").slice(0, 8);
  const ideas = Number(r.idea_count || 0);
  const mature = Number(r.mature_idea_count || 0);
  if (!ideas) return `${r.run_date} - no ideas - ${id}`;
  if (r.ready) return `${r.run_date} - ready ${mature}/${ideas} ideas - ${id}`;
  return `${r.run_date} - ${ideas} ideas, ready ${r.next_ready_on || r.ready_on || "later"} - ${id}`;
}

function PerfBucket({ title, rows }) {
  return (
    <div className="panel-elevated p-4">
      <div className="overline mb-3">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-3 text-[12px]">
            <span>{row.name}</span>
            <span className="font-mono text-right">
              {row.count} - {pct(row.hit_rate_pct)} - {pct(row.avg_return_pct)}
            </span>
          </div>
        ))}
        {!rows.length && <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No closed lifecycle data yet.</div>}
      </div>
    </div>
  );
}

function AttributionBucket({ title, rows }) {
  return (
    <div className="panel-elevated p-4">
      <div className="overline mb-3">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 text-[12px]">
            <span title={row.label}>{row.label}</span>
            <span className="font-mono text-right" style={{ color: Number(row.avg_weight || 0) >= 0 ? "var(--bullish)" : "var(--bearish)" }}>
              {row.count} - {Number(row.avg_weight || 0).toFixed(2)} - {pct(row.avg_return_pct)}
            </span>
          </div>
        ))}
        {!rows.length && <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No attribution sample yet.</div>}
      </div>
    </div>
  );
}
