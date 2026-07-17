/**
 * Daily funnel widget — full-universe → prefilter pool → shortlist →
 * scored → final ideas. Sourced from the `funnel` block on the latest report.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Filter, AlertTriangle } from "lucide-react";
import api from "../lib/api";

function Bar({ label, value, max, hint, onClick }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="w-full flex flex-col gap-1 text-left rounded-sm p-1 -mx-1 transition-colors disabled:opacity-100"
      style={{ cursor: onClick ? "pointer" : "default" }}
      data-testid={`funnel-stage-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <span className="text-[14px] font-bold" style={{ color: "var(--text-primary)" }}>
          {value?.toLocaleString?.() ?? value}
        </span>
      </div>
      <div className="h-[6px] rounded-full overflow-hidden" style={{ background: "var(--surface-elevated)" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, var(--accent-1), var(--accent-2))",
            transition: "width 600ms cubic-bezier(.16,.84,.44,1)",
          }}
        />
      </div>
      {hint && (
        <div className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>{hint}</div>
      )}
    </button>
  );
}

function fmtSec(s) {
  if (s == null) return null;
  if (s < 60) return `${s.toFixed(0)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

export default function FunnelWidget({ funnel, reportId }) {
  const [drill, setDrill] = useState(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rows, setRows] = useState([]);

  if (!funnel || !funnel.universe_total) return null;
  const max = funnel.universe_total || 1;
  const pool = funnel.prefilter_pool ?? funnel.pool ?? 0;
  const ranked = funnel.ranked ?? 0;
  const ideas = (funnel.weekly_ideas || 0) + (funnel.monthly_ideas || 0);
  const fallback = funnel.fallback_engaged === true;
  const t1 = funnel.stage1_seconds, t2 = funnel.stage2_seconds, t3 = funnel.stage3_seconds, total = funnel.total_seconds;
  const openDrilldown = async (stage) => {
    if (!reportId) return;
    setDrill(stage);
    if (rows.length) return;
    setLoadingRows(true);
    try {
      const { data } = await api.get(`/reports/${reportId}/funnel`);
      setRows(data.lite_rank_top || []);
    } finally {
      setLoadingRows(false);
    }
  };

  return (
    <section className="panel p-5" data-testid="funnel-widget">
      <div className="flex items-center justify-between mb-3">
        <div className="overline flex items-center gap-2"><Filter size={12} /> Daily Funnel</div>
        <div className="font-mono text-[10px] flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
          {total != null && <span>total {fmtSec(total)}</span>}
          {fallback ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={{ background: "rgba(255,170,0,0.12)", color: "#ffb84d" }}
                  data-testid="funnel-fallback-banner">
              <AlertTriangle size={11} /> bhavcopy unavailable · curated-51 fallback
            </span>
          ) : (
            <span style={{ color: "var(--bullish, #4ade80)" }}>full NSE universe</span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Bar label="Stage 1 · Universe scanned" value={funnel.universe_total} max={max}
             hint={`EQ-series stocks pulled from NSE master list${t1 ? ` · ${fmtSec(t1)}` : ""}`} />
        <Bar label="Stage 1 · Prefilter pool" value={pool} max={max}
             hint="Pass price ≥ ₹50 + turnover ≥ ₹1 Cr + delivery ≥ 20%" />
        <Bar label="Stage 1 · Ranked" value={ranked} max={max}
             hint="Stocks with enough price history for lightweight ranking"
             onClick={reportId ? () => openDrilldown("ranked") : undefined} />
        <Bar label="Stage 1 · Shortlisted" value={funnel.shortlisted} max={max}
             hint="Top by lightweight technical composite"
             onClick={reportId ? () => openDrilldown("shortlisted") : undefined} />
        <Bar label="Stage 2 · Deep-scored" value={funnel.scored} max={max}
             hint={`Fundamentals + news + LLM sentiment + earnings risk${t2 ? ` · ${fmtSec(t2)}` : ""}`}
             onClick={reportId ? () => openDrilldown("scored") : undefined} />
        <Bar label="Stage 3 · Final ideas" value={ideas} max={max}
             hint={`${funnel.weekly_ideas || 0} weekly · ${funnel.monthly_ideas || 0} monthly · ${funnel.excluded_by_earnings || 0} held off (earnings risk)${t3 ? ` · ${fmtSec(t3)}` : ""}`} />
      </div>
      {funnel.connector_failures > 0 && (
        <div className="mt-3 text-[11px] font-mono px-2 py-1 rounded" data-testid="funnel-failures"
             style={{ background: "rgba(255,90,90,0.1)", color: "#ff8b8b" }}>
          {funnel.connector_failures} connector failure(s) this run — see Admin → Audit Logs
        </div>
      )}
      {drill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.72)" }} data-testid="funnel-drilldown-modal">
          <div className="panel w-full max-w-5xl max-h-[82vh] overflow-hidden flex flex-col">
            <div className="p-4 border-b flex items-center justify-between gap-3" style={{ borderColor: "var(--border)" }}>
              <div>
                <div className="overline">Stage 1 Rank Drilldown</div>
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  Top lightweight technical candidates stored with this report.
                </div>
              </div>
              <button className="btn btn-outline" onClick={() => setDrill(null)} data-testid="funnel-drilldown-close">Close</button>
            </div>
            <div className="overflow-auto p-4">
              {loadingRows ? (
                <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>Loading rank table...</div>
              ) : rows.length ? (
                <table className="w-full data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Symbol</th><th>Name</th><th>Sector</th><th className="numeric">Lite</th>
                      <th className="numeric">Price</th><th className="numeric">RSI</th><th className="numeric">1M</th>
                      <th className="numeric">Vol</th><th>Setup</th><th>Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.symbol}-${i}`}>
                        <td className="font-mono text-[11px]">{i + 1}</td>
                        <td><Link to={`/explorer/${r.symbol}`} className="font-bold hover:underline">{r.symbol}</Link></td>
                        <td className="font-body text-[12px]">{r.name}</td>
                        <td>{r.sector}</td>
                        <td className="numeric">{Number(r.lite_score ?? 0).toFixed(1)}</td>
                        <td className="numeric">{r.last_close == null ? "-" : Number(r.last_close).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                        <td className="numeric">{r.rsi_14 == null ? "-" : Number(r.rsi_14).toFixed(1)}</td>
                        <td className="numeric">{r.change_pct_1m == null ? "-" : `${Number(r.change_pct_1m).toFixed(2)}%`}</td>
                        <td className="numeric">{r.volume_spike == null ? "-" : `${Number(r.volume_spike).toFixed(2)}x`}</td>
                        <td>{r.setup || "-"}</td>
                        <td className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{(r.lite_reasons || []).join(", ") || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>No rank rows stored for this report.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
