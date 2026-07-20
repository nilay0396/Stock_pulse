import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api from "../lib/api";
import { fmtNum, fmtPct, pctColor, fmtRupee, directionBadge } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";

export default function ReportPreview() {
  const { runId } = useParams();
  const [r, setR] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try { const { data } = await api.get(`/reports/${runId}`); setR(data); }
      finally { setLoading(false); }
    })();
  }, [runId]);

  if (loading) return <div className="p-8 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  if (!r) return <div className="p-8">Not found. <Link to="/reports" className="underline">Back</Link></div>;

  const macro = r.macro_snapshot || {};
  const summary = r.summary || {};
  const weekly = (r.ideas || []).filter((x) => x.horizon === "weekly");
  const monthly = (r.ideas || []).filter((x) => x.horizon === "monthly");
  const followups = summary.followups || {};
  const activeFollowups = Array.isArray(followups.active) ? followups.active : [];
  const resolvedFollowups = Array.isArray(followups.resolved) ? followups.resolved : [];

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="overline">Daily Brief · {r.run_date}</div>
          <h1 className="font-heading text-3xl md:text-4xl">Morning Market Report</h1>
          <div className="font-mono text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
            Status: {r.status} · Triggered by {r.triggered_by}
          </div>
        </div>
        <Link className="btn btn-outline" to="/reports" data-testid="back-reports-link">← All reports</Link>
      </header>

      <section className="panel p-5" data-testid="report-macro">
        <div className="overline mb-3">Macro Snapshot</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {["NIFTY","BANKNIFTY","INDIAVIX","USDINR","SP500","DXY","CRUDE","GOLD"].map((k) => {
            const m = macro[k];
            return (
              <div key={k} className="panel-elevated p-3">
                <div className="overline">{k}</div>
                <div className="font-mono text-[16px] mt-1">{m ? fmtNum(m.last) : "—"}</div>
                <div className="font-mono text-[11px]" style={{ color: pctColor(m?.change_pct) }}>{m ? fmtPct(m.change_pct) : ""}</div>
              </div>
            );
          })}
        </div>
      </section>

      {r.narrative && (
        <section className="panel p-5" data-testid="report-narrative-body">
          <div className="overline mb-3">Strategist Note</div>
          <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{r.narrative}</div>
        </section>
      )}

      <section className="panel p-5" data-testid="report-weekly-ideas">
        <div className="overline mb-3">Weekly Ideas</div>
        <IdeaTable ideas={weekly} />
      </section>

      <section className="panel p-5" data-testid="report-monthly-ideas">
        <div className="overline mb-3">Monthly Ideas</div>
        <IdeaTable ideas={monthly} />
      </section>

      <section className="panel p-5" data-testid="report-active-followups">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="overline">Active Follow-ups</div>
          <div className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
            {followups.checked || 0} checked
          </div>
        </div>
        <FollowupTable items={activeFollowups} empty="No active follow-ups yet." />
      </section>

      <section className="panel p-5" data-testid="report-resolved-followups">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="overline">Resolved Follow-ups</div>
          <div className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
            Target {followups.hit_target_count || 0} · Stop {followups.hit_stop_count || 0} · No entry {followups.no_entry_count || 0}
          </div>
        </div>
        <FollowupTable items={resolvedFollowups} empty="No recommendations resolved in this run." />
      </section>

      <section className="panel p-5">
        <div className="overline mb-3">Stance</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[13px]">
          <div><span style={{ color: "var(--bullish)" }}>Bullish sectors:</span> {(summary.bullish_sectors || []).join(", ") || "—"}</div>
          <div><span style={{ color: "var(--bearish)" }}>Cautious sectors:</span> {(summary.cautious_sectors || []).join(", ") || "—"}</div>
        </div>
        <div className="mt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Universe: {summary.universe_count} · Scored: {summary.scored_count}
        </div>
      </section>
    </div>
  );
}

function statusBadge(status) {
  const resolved = ["hit_target", "hit_stop", "expired", "no_entry", "no_data", "error"];
  if (status === "hit_target") return "badge badge-bullish";
  if (status === "hit_stop" || status === "error") return "badge badge-bearish";
  if (resolved.includes(status)) return "badge badge-watch";
  return "badge";
}

function FollowupTable({ items, empty }) {
  if (!items?.length) return <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full data-table">
        <thead><tr><th>Symbol</th><th>Status</th><th className="numeric">Current</th><th className="numeric">Return</th><th className="numeric">Days</th><th>Follow-up</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={`${i.trade_idea_id}-${i.status}`}>
              <td><Link to={`/explorer/${i.symbol}`} className="font-bold hover:underline">{i.symbol}</Link>
                <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{i.original_run_date} · {i.horizon}</div></td>
              <td><span className={statusBadge(i.status)}>{String(i.status || "").replace(/_/g, " ")}</span></td>
              <td className="numeric">{fmtRupee(i.current_price)}</td>
              <td className="numeric" style={{ color: pctColor(i.return_pct) }}>{i.return_pct === null || i.return_pct === undefined ? "—" : fmtPct(i.return_pct)}</td>
              <td className="numeric">{fmtNum(i.days_active, 0)}</td>
              <td className="text-[12px]" style={{ minWidth: 260 }}>{i.ai_followup || i.status_note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IdeaTable({ ideas }) {
  if (!ideas?.length) return <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No ideas in this bucket.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full data-table">
        <thead><tr><th>Symbol</th><th>Direction</th><th>Setup</th><th className="numeric">Entry</th><th className="numeric">Stop</th><th className="numeric">Target</th><th style={{minWidth:140}}>Conviction</th></tr></thead>
        <tbody>
          {ideas.map((i) => (
            <tr key={i.id}>
              <td><Link to={`/explorer/${i.symbol}`} className="font-bold hover:underline">{i.symbol}</Link>
                <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{i.sector}</div></td>
              <td><span className={directionBadge(i.direction)}>{i.direction}</span></td>
              <td>{i.setup_type}</td>
              <td className="numeric">{fmtRupee(i.entry_low)}–{fmtNum(i.entry_high)}</td>
              <td className="numeric">{fmtRupee(i.stop_loss)}</td>
              <td className="numeric">{fmtRupee(i.target_low)}–{fmtNum(i.target_high)}</td>
              <td><ConvictionBar value={i.conviction} direction={i.direction} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
