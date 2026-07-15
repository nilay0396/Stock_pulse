import { useParams, Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, fmtPct, pctColor, fmtRupee, directionBadge, fmtDate } from "../lib/fmt";
import ConvictionBar from "../components/ConvictionBar";
import { ShimmerLine, SkeletonList, SkeletonParagraph } from "../components/SkeletonBits";

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
          <div className="overline mb-2">Price · 6 Months</div>
          <div style={{ height: 320 }}>
            {showHistSk ? (
              <ShimmerLine w="100%" h={320} />
            ) : candles.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={candles.map((c) => ({ ...c, date: c.date }))}>
                  <CartesianGrid stroke="#1F1F24" strokeDasharray="2 4" />
                  <XAxis dataKey="date" stroke="#71717A" fontSize={10} minTickGap={40} />
                  <YAxis stroke="#71717A" fontSize={10} domain={["auto", "auto"]} width={60} />
                  <Tooltip contentStyle={{ background: "#0C0C0E", border: "1px solid #1F1F24", fontFamily: "JetBrains Mono", fontSize: 12 }}
                           labelStyle={{ color: "#A1A1AA" }} itemStyle={{ color: "#F4F4F5" }} />
                  {t.sma_50 && <ReferenceLine y={t.sma_50} stroke="#D97706" strokeDasharray="3 3" label={{ value: "SMA50", fontSize: 10, fill: "#D97706" }} />}
                  {t.sma_200 && <ReferenceLine y={t.sma_200} stroke="#00A36C" strokeDasharray="3 3" label={{ value: "SMA200", fontSize: 10, fill: "#00A36C" }} />}
                  <Line type="monotone" dataKey="close" stroke="#E4E4E7" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <div className="h-full flex items-center justify-center text-[12px]" style={{ color: "var(--text-muted)" }}>No history</div>}
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
