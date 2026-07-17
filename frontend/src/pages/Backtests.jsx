import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import api from "../lib/api";
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
  const [reports, setReports] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedReport, setSelectedReport] = useState("");
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [reportsRes, runsRes] = await Promise.all([
        api.get("/reports/history", { params: { limit: 50 } }),
        api.get("/backtests/runs", { params: { limit: 50 } }),
      ]);
      setReports(reportsRes.data || []);
      setRuns(runsRes.data || []);
      if (!selectedReport && reportsRes.data?.[0]?.id) setSelectedReport(reportsRes.data[0].id);
      if (!selectedRun && runsRes.data?.[0]?.id) await openRun(runsRes.data[0].id);
    } finally {
      setLoading(false);
    }
  }

  async function openRun(id) {
    const res = await api.get(`/backtests/runs/${id}`);
    setSelectedRun(res.data);
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
          <select
            className="input min-w-[280px]"
            value={selectedReport}
            onChange={(e) => setSelectedReport(e.target.value)}
            aria-label="Report run"
          >
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {r.run_date} - {r.status} - {(r.id || "").slice(0, 8)}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={runBacktest} disabled={!selectedReport || running}>
            {running ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
            {running ? "Running" : "Run Backtest"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Closed" value={summary.closed ?? 0} />
        <Stat label="Hit Rate" value={pct(summary.hit_rate_pct)} />
        <Stat label="Avg Return" value={pct(summary.avg_return_pct)} />
        <Stat label="Targets" value={summary.targets ?? 0} />
        <Stat label="No Data" value={summary.no_data ?? 0} />
      </div>

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
