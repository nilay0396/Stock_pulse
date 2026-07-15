/**
 * Daily funnel widget — full-universe → prefilter pool → shortlist →
 * scored → final ideas. Sourced from the `funnel` block on the latest report.
 */
import { Filter, AlertTriangle } from "lucide-react";

function Bar({ label, value, max, hint }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1" data-testid={`funnel-stage-${label.toLowerCase().replace(/\s+/g, "-")}`}>
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
    </div>
  );
}

function fmtSec(s) {
  if (s == null) return null;
  if (s < 60) return `${s.toFixed(0)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

export default function FunnelWidget({ funnel }) {
  if (!funnel || !funnel.universe_total) return null;
  const max = funnel.universe_total || 1;
  const ideas = (funnel.weekly_ideas || 0) + (funnel.monthly_ideas || 0);
  const fallback = funnel.fallback_engaged === true;
  const t1 = funnel.stage1_seconds, t2 = funnel.stage2_seconds, t3 = funnel.stage3_seconds, total = funnel.total_seconds;
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
        <Bar label="Stage 1 · Prefilter pool" value={funnel.prefilter_pool} max={max}
             hint="Pass price ≥ ₹50 + turnover ≥ ₹1 Cr + delivery ≥ 20%" />
        <Bar label="Stage 1 · Shortlisted" value={funnel.shortlisted} max={max}
             hint="Top by lightweight technical composite" />
        <Bar label="Stage 2 · Deep-scored" value={funnel.scored} max={max}
             hint={`Fundamentals + news + LLM sentiment + earnings risk${t2 ? ` · ${fmtSec(t2)}` : ""}`} />
        <Bar label="Stage 3 · Final ideas" value={ideas} max={max}
             hint={`${funnel.weekly_ideas || 0} weekly · ${funnel.monthly_ideas || 0} monthly · ${funnel.excluded_by_earnings || 0} held off (earnings risk)${t3 ? ` · ${fmtSec(t3)}` : ""}`} />
      </div>
      {funnel.connector_failures > 0 && (
        <div className="mt-3 text-[11px] font-mono px-2 py-1 rounded" data-testid="funnel-failures"
             style={{ background: "rgba(255,90,90,0.1)", color: "#ff8b8b" }}>
          {funnel.connector_failures} connector failure(s) this run — see Admin → Audit Logs
        </div>
      )}
    </section>
  );
}
