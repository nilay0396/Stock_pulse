import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, directionBadge, pctColor } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";
import { SkeletonTableRows } from "../components/SkeletonBits";
import ErrorState from "../components/ErrorState";

const PAGE_SIZE = 50;

function DataBadge({ ok, label }) {
  return (
    <span
      className="badge"
      style={{
        color: ok ? "var(--bullish)" : "var(--text-muted)",
        borderColor: ok ? "rgba(0,163,108,0.25)" : "var(--border)",
        background: ok ? "rgba(0,163,108,0.08)" : "var(--surface-elevated)",
      }}
    >
      {label}
    </span>
  );
}

function sortSectors(items) {
  return [...items].sort((a, b) => {
    if (a.name === "Other") return 1;
    if (b.name === "Other") return -1;
    return a.name.localeCompare(b.name);
  });
}

export default function StockExplorer() {
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("");
  const [minConv, setMinConv] = useState(0);
  const [scoreMode, setScoreMode] = useState("all");
  const [page, setPage] = useState(0);

  useEffect(() => { setPage(0); }, [q, sector, minConv, scoreMode]);

  const effectiveScoreMode = minConv > 0 ? "scored" : scoreMode;
  const key = `explorer:v2:${q}:${sector}:${minConv}:${effectiveScoreMode}:${page}`;
  const { data, loading, error, refetch } = useCached(key, () => api.get("/stocks/explorer", {
    params: {
      q: q || undefined,
      sector: sector || undefined,
      min_conviction: minConv || undefined,
      scored: effectiveScoreMode,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
  }).then((r) => r.data));

  const { data: sectors = [] } = useCached("explorer:sectors:v1",
    () => api.get("/stocks/sectors").then((r) => r.data));

  const rows = data?.rows || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total ? page * PAGE_SIZE + 1 : 0;
  const end = page * PAGE_SIZE + rows.length;
  const showRowsSk = loading && rows.length === 0;
  const sectorOptions = useMemo(() => sortSectors(sectors), [sectors]);

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="overline">Universe</div>
          <h1 className="font-heading text-3xl">Stock Explorer</h1>
          <div className="text-[12px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            {loading && !data
              ? "loading..."
              : `${fmtNum(data?.universe_total || 0, 0)} NSE EQ symbols · ${fmtNum(data?.latest_scored_rows || 0, 0)} scored (${fmtNum(data?.scored_coverage_pct || 0, 2)}%)`}
          </div>
        </div>
        <button className="btn btn-outline" onClick={refetch} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      <ErrorState error={error} fallback="Stock Explorer failed to load." onRetry={refetch} />

      <div className="panel p-4 flex flex-wrap items-end gap-4" data-testid="explorer-filter-bar">
        <label className="flex flex-col gap-1 min-w-[240px]">
          <span className="overline">Search</span>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" color="var(--text-muted)" />
            <input
              className="input pl-9"
              placeholder="Symbol or name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="explorer-search"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1 min-w-[190px]">
          <span className="overline">Sector</span>
          <select className="input" value={sector} onChange={(e) => setSector(e.target.value)} data-testid="explorer-sector">
            <option value="">All sectors</option>
            {sectorOptions.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.count})</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 min-w-[170px]">
          <span className="overline">Coverage</span>
          <select className="input" value={scoreMode} onChange={(e) => setScoreMode(e.target.value)} data-testid="explorer-scored">
            <option value="all">All symbols</option>
            <option value="scored">Scored only</option>
            <option value="unscored">Unscored only</option>
          </select>
        </label>

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
          <div className="font-mono text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
            Conviction filters apply to scored symbols only.
          </div>
        </div>
      </div>

      <div className="panel p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
          Showing {fmtNum(start, 0)}-{fmtNum(end, 0)} of {fmtNum(total, 0)}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading}>
            <ChevronLeft size={14} /> Prev
          </button>
          <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
            Page {fmtNum(page + 1, 0)} / {fmtNum(totalPages, 0)}
          </div>
          <button className="btn btn-outline" onClick={() => setPage((p) => p + 1)} disabled={!data?.next_offset || loading}>
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Sector</th>
              <th className="numeric">Last</th>
              <th>State</th>
              <th>Direction</th>
              <th className="numeric">Tech</th>
              <th className="numeric">Fund</th>
              <th className="numeric">Macro</th>
              <th style={{ minWidth: 150 }}>Conviction</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            {showRowsSk ? <SkeletonTableRows cols={10} rows={10} /> : rows.map((r) => {
              const score = r.score || {};
              const tech = r.technicals || {};
              return (
                <tr key={r.symbol} data-testid={`explorer-row-${r.symbol}`}>
                  <td>
                    <Link to={`/explorer/${r.symbol}`} className="font-bold hover:underline">{r.symbol}</Link>
                    <div className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{r.name || ""}</div>
                  </td>
                  <td className="font-body text-[12px]">
                    {r.sector || "Other"}
                    {!r.data_state?.sector_known && <div className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>untagged</div>}
                  </td>
                  <td className="numeric" style={{ color: pctColor(tech.change_pct_1d) }}>
                    {fmtNum(tech.last_close)}
                    {tech.change_pct_1d !== null && tech.change_pct_1d !== undefined && (
                      <div className="font-mono text-[10px]">{fmtNum(tech.change_pct_1d, 2)}%</div>
                    )}
                  </td>
                  <td>
                    <DataBadge ok={r.scored} label={r.scored ? "scored" : "not scored"} />
                  </td>
                  <td>{score.direction ? <span className={directionBadge(score.direction)}>{score.direction}</span> : <span style={{ color: "var(--text-muted)" }}>-</span>}</td>
                  <td className="numeric">{fmtNum(score.technical, 0)}</td>
                  <td className="numeric">{fmtNum(score.fundamental, 0)}</td>
                  <td className="numeric">{fmtNum(score.macro_sector, 0)}</td>
                  <td>{r.scored ? <ConvictionBar value={score.conviction} direction={score.direction} /> : <span style={{ color: "var(--text-muted)" }}>-</span>}</td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      <DataBadge ok={r.has_technicals} label="tech" />
                      <DataBadge ok={r.data_state?.industry_known} label="industry" />
                    </div>
                  </td>
                </tr>
              );
            })}
            {!showRowsSk && rows.length === 0 && (
              <tr><td colSpan={10} className="text-center py-10" style={{ color: "var(--text-muted)" }}>
                No symbols match the current filters.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
