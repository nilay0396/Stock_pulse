import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, directionBadge } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";
import { SkeletonTableRows } from "../components/SkeletonBits";

export default function StockExplorer() {
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("");
  const [minConv, setMinConv] = useState(0);

  const { data: rows = [], loading: lRows } = useCached("explorer:scores",
    () => api.get("/ideas/scores", { params: { limit: 500 } }).then((r) => r.data));
  const { data: uni = [], loading: lUni } = useCached("explorer:universe",
    () => api.get("/stocks/universe").then((r) => r.data));

  const uniMap = useMemo(() => Object.fromEntries(uni.map((x) => [x.symbol, x])), [uni]);
  const sectors = useMemo(() => Array.from(new Set(uni.map((x) => x.sector))).sort(), [uni]);

  const filtered = rows.filter((r) => {
    if (r.conviction < minConv) return false;
    if (sector && r.sector !== sector) return false;
    if (q && !r.symbol.toLowerCase().includes(q.toLowerCase()) && !(r.name || "").toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  // Preview what the weekly / monthly idea pool would look like at the
  // current threshold (pure scoring — earnings calendar still applies on top
  // in the real pipeline). Useful for gauging strictness on quiet weeks.
  const weeklyPreview = rows.filter(
    (r) => r.passes_filters && r.conviction >= Math.max(minConv, 72) && r.technical >= 70,
  ).length;
  const monthlyPreview = rows.filter(
    (r) => r.passes_filters && r.conviction >= Math.max(minConv, 75)
      && r.fundamental >= 70 && r.macro_sector >= 65,
  ).length;
  const atOrAbove = rows.filter((r) => r.conviction >= minConv).length;

  const showRowsSk = lRows && rows.length === 0;
  const initial = (lRows && rows.length === 0) || (lUni && uni.length === 0);

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="overline">Universe</div>
          <h1 className="font-heading text-3xl">Stock Explorer</h1>
          <div className="text-[12px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            {initial ? "loading…" : `${uni.length} symbols · ${rows.length} scored`}
          </div>
        </div>
      </header>

      <div className="panel p-4 flex flex-wrap items-end gap-4" data-testid="explorer-filter-bar">
        <input className="input max-w-[240px]" placeholder="Search symbol / name…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="explorer-search" />
        <select className="input max-w-[180px]" value={sector} onChange={(e) => setSector(e.target.value)} data-testid="explorer-sector">
          <option value="">All sectors</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex flex-col gap-1 flex-1 min-w-[260px]">
          <div className="flex items-center justify-between">
            <span className="overline">Min conviction: <b className="font-mono ml-1" style={{ color: "var(--text-primary)" }}>{minConv}</b></span>
            <div className="flex gap-1">
              {[0, 60, 65, 70, 72, 75].map((v) => (
                <button key={v} onClick={() => setMinConv(v)} data-testid={`preset-${v}`}
                        className="font-mono text-[10.5px] px-2 py-0.5 rounded-sm"
                        style={{
                          background: minConv === v ? "var(--text-primary)" : "var(--surface-elevated)",
                          color: minConv === v ? "var(--background)" : "var(--text-muted)",
                        }}>{v}</button>
              ))}
            </div>
          </div>
          <input type="range" min="0" max="100" step="1" value={minConv}
                 onChange={(e) => setMinConv(Number(e.target.value))}
                 className="w-full accent-white cursor-pointer"
                 style={{ height: 4 }}
                 data-testid="conviction-slider" />
          <div className="flex gap-5 font-mono text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
            <span data-testid="stat-above">{atOrAbove} stock{atOrAbove === 1 ? "" : "s"} ≥ {minConv}</span>
            <span data-testid="stat-weekly" style={{ color: weeklyPreview > 0 ? "var(--bullish)" : "var(--text-muted)" }}>
              Weekly pool: {weeklyPreview}
            </span>
            <span data-testid="stat-monthly" style={{ color: monthlyPreview > 0 ? "var(--bullish)" : "var(--text-muted)" }}>
              Monthly pool: {monthlyPreview}
            </span>
          </div>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Sector</th>
              <th className="numeric">Last</th>
              <th>Direction</th>
              <th className="numeric">Tech</th>
              <th className="numeric">Fund</th>
              <th className="numeric">Val</th>
              <th className="numeric">Analyst</th>
              <th className="numeric">News</th>
              <th className="numeric">Macro</th>
              <th style={{ minWidth: 150 }}>Conviction</th>
            </tr>
          </thead>
          <tbody>
            {showRowsSk ? <SkeletonTableRows cols={11} rows={10} /> : filtered.map((r) => (
              <tr key={r.id || r.symbol} data-testid={`score-row-${r.symbol}`}>
                <td>
                  <Link to={`/explorer/${r.symbol}`} className="font-bold hover:underline">{r.symbol}</Link>
                  <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{uniMap[r.symbol]?.name || r.name || ""}</div>
                </td>
                <td className="font-body text-[12px]">{r.sector}</td>
                <td className="numeric">{fmtNum(r.last_close)}</td>
                <td><span className={directionBadge(r.direction)}>{r.direction}</span></td>
                <td className="numeric">{fmtNum(r.technical, 0)}</td>
                <td className="numeric">{fmtNum(r.fundamental, 0)}</td>
                <td className="numeric">{fmtNum(r.valuation, 0)}</td>
                <td className="numeric">{fmtNum(r.analyst, 0)}</td>
                <td className="numeric">{fmtNum(r.event_news, 0)}</td>
                <td className="numeric">{fmtNum(r.macro_sector, 0)}</td>
                <td><ConvictionBar value={r.conviction} direction={r.direction} /></td>
              </tr>
            ))}
            {!showRowsSk && filtered.length === 0 && (
              <tr><td colSpan={11} className="text-center py-10" style={{ color: "var(--text-muted)" }}>
                No scores available. Run the engine from the Dashboard.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
