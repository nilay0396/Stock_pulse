import { useParams, Link } from "react-router-dom";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, fmtPct, pctColor, fmtRupee, directionBadge, fmtDate } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";
import { ShimmerLine, SkeletonList, SkeletonParagraph } from "../components/SkeletonBits";

function CandlestickChart({ candles, sma50, sma200 }) {
  const rows = (candles || []).filter((c) => c.close != null && c.high != null && c.low != null);
  if (rows.length < 2) return null;
  const prices = rows
    .flatMap((c) => [c.high, c.low, c.open ?? c.close, c.close, sma50, sma200])
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 920;
  const h = 280;
  const pad = 12;
  const stepX = w / rows.length;
  const bodyW = Math.max(1.5, Math.min(9, stepX * 0.58));
  const y = (p) => pad + (h - pad * 2) - ((Number(p) - min) / range) * (h - pad * 2);

  return (
    <svg viewBox={`0 0 ${w} ${h + 24}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }} data-testid="stock-candlestick-chart">
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={w} y1={pad + g * (h - pad * 2)} y2={pad + g * (h - pad * 2)}
              stroke="var(--border)" strokeDasharray="2 6" strokeWidth="1" />
      ))}
      {sma50 && <line x1="0" x2={w} y1={y(sma50)} y2={y(sma50)} stroke="#D97706" strokeDasharray="4 4" strokeWidth="1" />}
      {sma200 && <line x1="0" x2={w} y1={y(sma200)} y2={y(sma200)} stroke="#00A36C" strokeDasharray="4 4" strokeWidth="1" />}
      {rows.map((c, i) => {
        const x = i * stepX + stepX / 2;
        const open = c.open ?? c.close;
        const green = c.close >= open;
        const color = green ? "#4ade80" : "#f87171";
        const yOpen = y(open);
        const yClose = y(c.close);
        return (
          <g key={`${c.date}-${i}`}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
            <rect
              x={x - bodyW / 2}
              y={Math.min(yOpen, yClose)}
              width={bodyW}
              height={Math.max(1, Math.abs(yOpen - yClose))}
              fill={green ? "rgba(74,222,128,0.72)" : "rgba(248,113,113,0.78)"}
              stroke={color}
              strokeWidth="0.6"
            />
          </g>
        );
      })}
      <text x="6" y={h + 16} fontSize="10" fontFamily="monospace" fill="var(--text-muted)">
        {rows[0].date} to {rows[rows.length - 1].date} · {fmtRupee(min)} to {fmtRupee(max)}
      </text>
    </svg>
  );
}

export default function StockDetail() {
  const { symbol } = useParams();
  const { data: detail, loading: lDetail } = useCached(
    `stock:${symbol}`,
    () => api.get(`/stocks/${symbol}`).then((r) => r.data),
  );
  const { data: histResp, loading: lHist } = useCached(
    `stock:${symbol}:hist`,
    () => api.get(`/stocks/${symbol}/history`, { params: { period: "6mo" } }).then((r) => r.data),
  );
  const candles = histResp?.candles || [];

  if (!lDetail && detail && !detail.universe) {
    return <div className="p-8">Not found. <Link to="/explorer" className="underline">Back</Link></div>;
  }

  const showDetailSk = lDetail && !detail;
  const showHistSk = lHist && candles.length === 0;
  const u = detail?.universe || {};
  const t = detail?.technicals || {};
  const s = detail?.score || {};
  const news = detail?.news || [];

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="overline">
            {showDetailSk ? <ShimmerLine w={140} h={10} /> : `${u.sector || ""} · ${u.industry || ""}`}
          </div>
          <h1 className="font-heading text-3xl md:text-4xl tracking-tight">
            {showDetailSk ? <ShimmerLine w={260} h={30} /> : u.name}
          </h1>
          <div className="font-mono text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
            {showDetailSk ? <ShimmerLine w={180} h={12} /> : `${u.symbol} · NSE · ${u.yf_symbol}`}
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div>
            <div className="overline">Last</div>
            <div className="font-mono text-[28px]">
              {showDetailSk ? <ShimmerLine w={120} h={28} /> : fmtRupee(t.last_close)}
            </div>
          </div>
          <div>
            <div className="overline">1D · 1W · 1M</div>
            <div className="flex gap-3 font-mono text-[14px]">
              {showDetailSk ? <ShimmerLine w={160} h={14} /> : (
                <>
                  <span style={{ color: pctColor(t.change_pct_1d) }}>{fmtPct(t.change_pct_1d)}</span>
                  <span style={{ color: pctColor(t.change_pct_1w) }}>{fmtPct(t.change_pct_1w)}</span>
                  <span style={{ color: pctColor(t.change_pct_1m) }}>{fmtPct(t.change_pct_1m)}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <section className="panel p-4 lg:col-span-8" data-testid="stock-chart">
          <div className="overline mb-2">Candlestick Price · 6 Months</div>
          <div style={{ height: 320 }}>
            {showHistSk ? (
              <ShimmerLine w="100%" h={320} />
            ) : candles.length > 0 ? (
              <CandlestickChart candles={candles} sma50={t.sma_50} sma200={t.sma_200} />
            ) : <div className="h-full flex items-center justify-center text-[12px]" style={{ color: "var(--text-muted)" }}>No history</div>}
          </div>
          <div className="mt-2 flex gap-4 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            <span style={{ color: "#D97706" }}>SMA50</span>
            <span style={{ color: "#00A36C" }}>SMA200</span>
            <span>Source: {(histResp?.source || "unknown").toUpperCase()}</span>
          </div>
        </section>

        <section className="panel p-4 lg:col-span-4" data-testid="stock-score">
          <div className="overline mb-3">Conviction</div>
          {showDetailSk ? (
            <SkeletonParagraph lines={8} />
          ) : s && s.conviction !== undefined ? (
            <>
              <div className="flex items-baseline justify-between">
                <div className="font-heading text-5xl">{Math.round(s.conviction)}</div>
                <span className={directionBadge(s.direction)}>{s.direction}</span>
              </div>
              <div className="mt-4"><ConvictionBar value={s.conviction} direction={s.direction} /></div>
              <div className="mt-5 flex flex-col gap-1.5 text-[12px]">
                {["technical","fundamental","valuation","ownership","analyst","event_news","macro_sector"].map((k) => (
                  <div key={k} className="flex items-center justify-between">
                    <span style={{ color: "var(--text-muted)" }} className="capitalize">{k.replace("_"," ")}</span>
                    <span className="font-mono">{fmtNum(s[k], 0)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No score yet. Generate a report.</div>}
        </section>

        <section className="panel p-4 lg:col-span-6" data-testid="stock-technicals">
          <div className="overline mb-3">Technicals</div>
          {showDetailSk ? (
            <SkeletonList rows={7} height={20} />
          ) : (
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-[12.5px]">
              {[
                ["RSI(14)", t.rsi_14],
                ["SMA 20", t.sma_20],
                ["SMA 50", t.sma_50],
                ["SMA 200", t.sma_200],
                ["EMA 20", t.ema_20],
                ["MACD", t.macd],
                ["MACD Signal", t.macd_signal],
                ["ATR(14)", t.atr_14],
                ["BB Upper", t.bb_upper],
                ["BB Lower", t.bb_lower],
                ["Volatility 20d", t.volatility_20],
                ["Volume Spike", t.volume_spike],
                ["Rel. Strength", t.relative_strength],
                ["Setup", t.setup],
              ].map(([label, val]) => (
                <div key={label} className="flex items-center justify-between border-b py-1" style={{ borderColor: "var(--border)" }}>
                  <span style={{ color: "var(--text-muted)" }}>{label}</span>
                  <span className="font-mono">{typeof val === "number" ? fmtNum(val, 2) : (val || "—")}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel p-4 lg:col-span-6" data-testid="stock-reasons">
          <div className="overline mb-3">Reasoning</div>
          {showDetailSk ? (
            <SkeletonParagraph lines={8} />
          ) : (
            <>
              <div className="text-[11px] overline mb-2">Pros</div>
              <ul className="flex flex-col gap-1 text-[12.5px] mb-4">
                {(s.reasons || []).map((r, i) => <li key={i} className="flex gap-2"><span style={{ color: "var(--bullish)" }}>▲</span>{r}</li>)}
                {!s.reasons?.length && <li style={{ color: "var(--text-muted)" }}>—</li>}
              </ul>
              <div className="text-[11px] overline mb-2">Risks</div>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {(s.risks || []).map((r, i) => <li key={i} className="flex gap-2"><span style={{ color: "var(--bearish)" }}>▼</span>{r}</li>)}
                {!s.risks?.length && <li style={{ color: "var(--text-muted)" }}>—</li>}
              </ul>
            </>
          )}
        </section>

        <section className="panel p-4 lg:col-span-12" data-testid="stock-news">
          <div className="overline mb-3">Latest Headlines</div>
          {showDetailSk ? (
            <SkeletonList rows={5} height={36} />
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
              {news.map((n, i) => (
                <a key={n.link || `${n.publisher}-${n.published_at || i}`} className="py-2 hover:bg-[var(--surface-elevated)] px-1 -mx-1" target="_blank" rel="noreferrer" href={n.link}>
                  <div className="text-[13px]">{n.title}</div>
                  <div className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>{n.publisher} · {fmtDate(n.published_at || n.ingested_at)}</div>
                </a>
              ))}
              {news.length === 0 && <div className="py-4 text-[12px]" style={{ color: "var(--text-muted)" }}>No news ingested yet.</div>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
