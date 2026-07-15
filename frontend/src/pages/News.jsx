import { useState } from "react";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtDate } from "../lib/fmt";
import { SkeletonList } from "../components/SkeletonBits";

export default function News() {
  const [symbol, setSymbol] = useState("");
  const { data: items = [], loading } = useCached(
    `news:${symbol}`,
    () => api.get("/news", { params: symbol ? { symbol, limit: 100 } : { limit: 100 } }).then((r) => r.data),
  );
  const showSk = loading && items.length === 0;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="overline">Headlines</div>
          <h1 className="font-heading text-3xl">News Feed</h1>
        </div>
        <input className="input max-w-[260px]" placeholder="Filter by symbol (e.g. RELIANCE)" value={symbol}
               onChange={(e) => setSymbol(e.target.value.toUpperCase())} data-testid="news-filter-symbol" />
      </header>

      <div className="panel divide-y" style={{ borderColor: "var(--border)" }} data-testid="news-list">
        {showSk ? (
          <div className="p-4"><SkeletonList rows={10} height={44} /></div>
        ) : (
          <>
            {items.map((n, i) => (
              <a key={n.link || `${n.symbol}-${n.published_at || n.ingested_at || i}`} className="block px-4 py-3 hover:bg-[var(--surface-elevated)]" target="_blank" rel="noreferrer" href={n.link}>
                <div className="text-[13.5px]">{n.title}</div>
                <div className="text-[11px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
                  {(n.symbol ? `${n.symbol} · ` : "") + (n.publisher || "—")} · {fmtDate(n.published_at || n.ingested_at)}
                </div>
              </a>
            ))}
            {items.length === 0 && (
              <div className="p-8 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>
                No headlines yet. Headlines are ingested during the daily report run.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
