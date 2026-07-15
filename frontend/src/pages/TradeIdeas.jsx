import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtRupee, fmtNum, directionBadge } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";
import { SkeletonTableRows } from "../components/SkeletonBits";

export default function TradeIdeas() {
  const [horizon, setHorizon] = useState("");
  const [direction, setDirection] = useState("");
  const [sector, setSector] = useState("");
  const [minConv, setMinConv] = useState(0);

  const key = `ideas:${horizon}:${direction}:${sector}:${minConv}`;
  const { data: ideas = [], loading } = useCached(key, () => {
    const params = { limit: 100 };
    if (horizon) params.horizon = horizon;
    if (direction) params.direction = direction;
    if (sector) params.sector = sector;
    if (minConv) params.min_conviction = minConv;
    return api.get("/ideas", { params }).then((r) => r.data);
  });

  const { data: excluded = [] } = useCached("ideas:excluded",
    () => api.get("/ideas/excluded").then((r) => r.data));

  const sectors = useMemo(() => {
    const s = new Set(ideas.map((i) => i.sector).filter(Boolean));
    return Array.from(s);
  }, [ideas]);

  const showSkeletons = loading && ideas.length === 0;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Signals</div>
        <h1 className="font-heading text-3xl">Trade Ideas</h1>
      </header>

      <div className="panel p-4 flex flex-wrap gap-3" data-testid="ideas-filter-bar">
        <select className="input max-w-[180px]" value={horizon} onChange={(e) => setHorizon(e.target.value)} data-testid="filter-horizon">
          <option value="">All horizons</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <select className="input max-w-[180px]" value={direction} onChange={(e) => setDirection(e.target.value)} data-testid="filter-direction">
          <option value="">All directions</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
          <option value="watch">Watch</option>
        </select>
        <select className="input max-w-[180px]" value={sector} onChange={(e) => setSector(e.target.value)} data-testid="filter-sector">
          <option value="">All sectors</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex items-center gap-2 ml-auto">
          <span className="overline">Min conviction</span>
          <input className="input w-[100px]" type="number" min="0" max="100" value={minConv}
                 onChange={(e) => setMinConv(Number(e.target.value || 0))} data-testid="filter-min-conv" />
        </div>
      </div>

      <div className="panel overflow-x-auto" data-testid="ideas-table">
        <table className="w-full data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Sector</th>
              <th>Direction</th>
              <th>Horizon</th>
              <th>Setup</th>
              <th className="numeric">Entry</th>
              <th className="numeric">Stop</th>
              <th className="numeric">Target</th>
              <th style={{ minWidth: 140 }}>Conviction</th>
            </tr>
          </thead>
          <tbody>
            {showSkeletons ? <SkeletonTableRows cols={9} rows={8} /> : ideas.map((i) => (
              <Fragment key={i.id}>
              <tr data-testid={`idea-row-${i.symbol}`}>
                <td>
                  <Link to={`/explorer/${i.symbol}`} className="font-bold hover:underline">{i.symbol}</Link>
                  <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{i.name}</div>
                </td>
                <td className="font-body text-[12px]">{i.sector}</td>
                <td><span className={directionBadge(i.direction)}>{i.direction}</span></td>
                <td>{i.horizon}</td>
                <td>{i.setup_type}</td>
                <td className="numeric">{fmtRupee(i.entry_low)}–{fmtNum(i.entry_high)}</td>
                <td className="numeric">{fmtRupee(i.stop_loss)}</td>
                <td className="numeric">{fmtRupee(i.target_low)}–{fmtNum(i.target_high)}</td>
                <td><ConvictionBar value={i.conviction} direction={i.direction} /></td>
              </tr>
              {i.rationale && (
                <tr data-testid={`idea-rationale-${i.symbol}`}>
                  <td colSpan={9} className="py-2 px-3" style={{ color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.55, background: "var(--surface-elevated)" }}>
                    <span className="overline mr-2" style={{ color: "var(--text-muted)" }}>Why:</span>
                    {i.rationale}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {!showSkeletons && ideas.length === 0 && (
              <tr><td colSpan={9} className="text-center py-10" style={{ color: "var(--text-muted)" }}>
                {excluded.length > 0
                  ? "No tradeable ideas today — top candidates are blocked by the earnings calendar (see below)."
                  : "No ideas match current filters. Try lowering the conviction threshold, or generate a new report."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {excluded.length > 0 && (
        <section className="panel p-5" data-testid="excluded-panel">
          <div className="overline mb-2">Blocked by Earnings Calendar</div>
          <p className="text-[12.5px] mb-3" style={{ color: "var(--text-secondary)" }}>
            These stocks cleared the scoring gates but were excluded because their next
            earnings fall inside the holding horizon (weekly &gt; 10d, monthly &gt; 35d).
            Watch-only — take the trade after results are out.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full data-table">
              <thead><tr>
                <th>Symbol</th><th>Sector</th><th className="numeric">Conv</th>
                <th className="numeric">T</th><th className="numeric">F</th><th className="numeric">M</th>
                <th>Would-qualify</th><th>Next earnings</th><th className="numeric">Days</th>
              </tr></thead>
              <tbody>
                {excluded.map((e) => (
                  <tr key={e.symbol} data-testid={`excluded-row-${e.symbol}`}>
                    <td>
                      <Link to={`/explorer/${e.symbol}`} className="font-bold hover:underline">{e.symbol}</Link>
                      <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{e.name}</div>
                    </td>
                    <td className="font-body text-[12px]">{e.sector}</td>
                    <td className="numeric">{fmtNum(e.conviction, 1)}</td>
                    <td className="numeric">{fmtNum(e.technical, 0)}</td>
                    <td className="numeric">{fmtNum(e.fundamental, 0)}</td>
                    <td className="numeric">{fmtNum(e.macro_sector, 0)}</td>
                    <td className="font-body text-[12px]">{(e.would_qualify || []).join(", ")}</td>
                    <td className="font-mono text-[12px]">{e.next_earnings || "—"}</td>
                    <td className="numeric" style={{ color: "var(--warning, #D97706)" }}>{e.earnings_in_days ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
