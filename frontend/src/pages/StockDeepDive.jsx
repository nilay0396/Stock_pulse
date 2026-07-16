/**
 * Stock Deep Dive Explorer — search any NSE EQ stock and get a live, full
 * deep-dive view: quote → chart → technicals → fundamentals → events → news →
 * F&O → AI memo + buy/hold/sell verdict for weekly + monthly horizons.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Loader2, AlertTriangle, RefreshCw, ChevronRight,
  Activity, BarChart3, Layers, Newspaper, Calendar, BookOpen, Brain,
} from "lucide-react";
import { toast } from "sonner";
import api from "../lib/api";

// ---------- helpers ----------
const fmt = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }));
const pct = (v, d = 2) => (v == null ? "—" : `${Number(v).toFixed(d)}%`);
const cr = (v) => (v == null ? "—" : `₹${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`);

const VERDICT_COLORS = {
  buy:   { bg: "rgba(74,222,128,0.14)", fg: "#4ade80", label: "BUY" },
  hold:  { bg: "rgba(250,204,21,0.14)", fg: "#facc15", label: "HOLD" },
  sell:  { bg: "rgba(248,113,113,0.14)", fg: "#f87171", label: "SELL" },
  avoid: { bg: "rgba(148,163,184,0.16)", fg: "#94a3b8", label: "AVOID" },
};

function VerdictPill({ verdict }) {
  const v = VERDICT_COLORS[verdict] || VERDICT_COLORS.avoid;
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wider"
          style={{ background: v.bg, color: v.fg }}
          data-testid={`verdict-${verdict}`}>
      {v.label}
    </span>
  );
}

// ---------- Search bar with autocomplete ----------
function SearchBar({ onPick }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (q.trim().length < 1) { setResults([]); setOpen(false); return; }
    setLoading(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { data } = await api.get("/stocks/search", { params: { q, limit: 10 } });
        setResults(data || []);
        setOpen(true);
      } catch { /* swallow */ }
      finally { setLoading(false); }
    }, 180);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  return (
    <div className="relative w-full max-w-xl" data-testid="deepdive-search">
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} style={{ color: "var(--text-muted)" }} />}
        <input
          autoFocus
          placeholder="Search NSE: SBIN, RELIANCE, TCS, HINDZINC…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) { onPick(results[0]); setQ(""); setOpen(false); } }}
          className="flex-1 bg-transparent outline-none text-[13px]"
          data-testid="deepdive-search-input"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border overflow-hidden"
             style={{ borderColor: "var(--border)", background: "var(--surface)" }}
             data-testid="deepdive-search-results">
          {results.map((r) => (
            <button key={r.symbol}
                    className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-[var(--surface-elevated)] transition-colors"
                    onMouseDown={(e) => { e.preventDefault(); onPick(r); setQ(""); setOpen(false); }}
                    data-testid={`search-result-${r.symbol}`}>
              <div className="flex flex-col">
                <span className="font-mono text-[13px] font-semibold">{r.symbol}</span>
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{r.name}</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{ background: "var(--surface-elevated)", color: "var(--text-muted)" }}>
                {r.sector || "—"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- candlestick chart from OHLC candles ----------
function PriceChart({ ohlc }) {
  if (!ohlc || ohlc.length < 5) return <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>Not enough price history.</div>;
  const candles = ohlc.filter((b) => b.close != null && b.high != null && b.low != null);
  if (candles.length < 2) return null;
  const prices = candles.flatMap((b) => [b.high, b.low, b.open ?? b.close, b.close]).filter((v) => v != null && v > 0);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const w = 900, h = 240;
  const pad = 8;
  const stepX = w / candles.length;
  const bodyW = Math.max(1.2, Math.min(8, stepX * 0.58));
  const y = (p) => pad + (h - pad * 2) - ((p - min) / range) * (h - pad * 2);
  const last = candles[candles.length - 1].close;
  const first = candles[0].close;
  const up = last >= first;
  return (
    <svg viewBox={`0 0 ${w} ${h + 24}`} preserveAspectRatio="none" style={{ width: "100%", height: 280 }} data-testid="deepdive-chart">
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={w} y1={pad + g * (h - pad * 2)} y2={pad + g * (h - pad * 2)}
              stroke="var(--border)" strokeDasharray="2 6" strokeWidth="1" />
      ))}
      {candles.map((c, i) => {
        const x = i * stepX + stepX / 2;
        const open = c.open ?? c.close;
        const green = c.close >= open;
        const color = green ? "#4ade80" : "#f87171";
        const yOpen = y(open);
        const yClose = y(c.close);
        const top = Math.min(yOpen, yClose);
        const height = Math.max(1, Math.abs(yOpen - yClose));
        return (
          <g key={`${c.date}-${i}`}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
            <rect x={x - bodyW / 2} y={top} width={bodyW} height={height}
                  fill={green ? "rgba(74,222,128,0.7)" : "rgba(248,113,113,0.75)"}
                  stroke={color} strokeWidth="0.6" />
          </g>
        );
      })}
      <text x="6" y={h + 16} fontSize="10" fontFamily="monospace" fill="var(--text-muted)">
        {ohlc[0].date} → {ohlc[ohlc.length - 1].date} · {fmt(min)} – {fmt(max)}
      </text>
    </svg>
  );
}

// ---------- Tabbed body ----------
function TabHeader({ tab, setTab }) {
  const tabs = [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "chart", label: "Chart", icon: BarChart3 },
    { id: "technicals", label: "Technicals", icon: Layers },
    { id: "fno", label: "F&O", icon: BookOpen },
    { id: "news", label: "News", icon: Newspaper },
    { id: "events", label: "Events", icon: Calendar },
    { id: "fundamentals", label: "Fundamentals", icon: BookOpen },
    { id: "score", label: "AI Analysis", icon: Brain },
  ];
  return (
    <div className="flex gap-1 border-b overflow-x-auto" style={{ borderColor: "var(--border)" }}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = tab === t.id;
        return (
          <button key={t.id}
                  onClick={() => setTab(t.id)}
                  data-testid={`tab-${t.id}`}
                  className="px-3 py-2 flex items-center gap-2 text-[12px] whitespace-nowrap transition-colors"
                  style={{
                    color: active ? "var(--text-primary)" : "var(--text-muted)",
                    borderBottom: active ? "2px solid var(--text-primary)" : "2px solid transparent",
                    fontWeight: active ? 600 : 400,
                  }}>
            <Icon size={13} /> {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Per-tab panels (kept small) ----------
function OverviewTab({ d }) {
  const t = d.technicals || {};
  const w = d.weekly || {}, m = d.monthly || {};
  const planRow = (label, plan) => (
    <div className="panel-elevated p-3 flex flex-col gap-2" data-testid={`plan-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between">
        <div className="overline">{label} ({plan.horizon_days || ""}d)</div>
        <VerdictPill verdict={plan.verdict || "avoid"} />
      </div>
      {plan.plan?.entry_low ? (
        <div className="grid grid-cols-2 gap-2 text-[12px] font-mono">
          <div><span style={{ color: "var(--text-muted)" }}>Entry</span><div>₹{fmt(plan.plan.entry_low)} – {fmt(plan.plan.entry_high)}</div></div>
          <div><span style={{ color: "var(--text-muted)" }}>Stop</span><div style={{ color: "#f87171" }}>₹{fmt(plan.plan.stop_loss)}</div></div>
          {plan.plan.target_1 != null && <div><span style={{ color: "var(--text-muted)" }}>Target 1</span><div style={{ color: "#4ade80" }}>₹{fmt(plan.plan.target_1)}</div></div>}
          {plan.plan.target_2 != null && <div><span style={{ color: "var(--text-muted)" }}>Target 2</span><div style={{ color: "#4ade80" }}>₹{fmt(plan.plan.target_2)}</div></div>}
          {plan.plan.rr != null && <div className="col-span-2"><span style={{ color: "var(--text-muted)" }}>R:R</span> <span>{fmt(plan.plan.rr)}</span></div>}
        </div>
      ) : (
        <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          {plan.verdict === "avoid" ? "Setup does not pass strict filters; not actionable today." : "No actionable trade plan."}
        </div>
      )}
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="panel-elevated p-3" data-testid="overview-quote">
        <div className="overline">Last close</div>
        <div className="font-mono text-[26px]">₹{fmt(t.last_close)}</div>
        <div className="text-[12px] mt-1" style={{ color: t.change_pct_1m >= 0 ? "#4ade80" : "#f87171" }}>
          1M: {pct(t.change_pct_1m)}  · 3M: {pct(t.change_pct_3m)}
        </div>
        <div className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
          {d.sector || "—"} · {d.industry || "—"}
        </div>
      </div>
      <div className="panel-elevated p-3" data-testid="overview-conviction">
        <div className="overline">Conviction</div>
        <div className="font-mono text-[26px]">{fmt(d.score?.conviction, 1)}<span className="text-[12px]" style={{ color: "var(--text-muted)" }}> /100</span></div>
        <div className="text-[12px]">Direction: <b style={{ color: d.score?.direction === "bullish" ? "#4ade80" : d.score?.direction === "bearish" ? "#f87171" : "var(--text-muted)" }}>{d.score?.direction || "—"}</b></div>
        <div className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
          {d.score?.passes_filters ? "Passes hard filters" : `Filtered out: ${(d.score?.filter_rejects || []).slice(0, 2).join(", ")}`}
        </div>
      </div>
      {planRow("Weekly", w)}
      {planRow("Monthly", m)}
    </div>
  );
}

function TechnicalsTab({ d }) {
  const t = d.technicals || {};
  const items = [
    ["RSI 14", fmt(t.rsi_14, 1)], ["ATR 14", fmt(t.atr_14, 2)],
    ["SMA 20", fmt(t.sma_20)], ["SMA 50", fmt(t.sma_50)],
    ["SMA 100", fmt(t.sma_100)], ["SMA 200", fmt(t.sma_200)],
    ["EMA 20", fmt(t.ema_20)], ["EMA 50", fmt(t.ema_50)],
    ["MACD", fmt(t.macd, 3)], ["MACD signal", fmt(t.macd_signal, 3)],
    ["BB upper", fmt(t.bb_upper)], ["BB lower", fmt(t.bb_lower)],
    ["Vol spike", fmt(t.volume_spike, 2) + "×"],
    ["Rel. strength", pct(t.relative_strength, 2)],
    ["Setup", t.setup || "—"],
    ["1-month change", pct(t.change_pct_1m)],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="tab-content-technicals">
      {items.map(([k, v]) => (
        <div key={k} className="panel-elevated p-3">
          <div className="overline">{k}</div>
          <div className="font-mono text-[14px] mt-1">{v}</div>
        </div>
      ))}
    </div>
  );
}

function FundamentalsTab({ d }) {
  const f = d.fundamentals || {};
  const items = [
    ["Market cap", cr(f.marketCap)],
    ["P/E (trailing)", fmt(f.trailingPE, 2)],
    ["EPS (TTM)", fmt(f.trailingEps, 2)],
    ["P/B", fmt(f.priceToBook, 2)],
    ["ROE", pct((f.returnOnEquity || 0) * 100, 2)],
    ["Profit margin", pct((f.profitMargins || 0) * 100, 2)],
    ["Revenue growth", pct((f.revenueGrowth || 0) * 100, 2)],
    ["Earnings growth", pct((f.earningsGrowth || 0) * 100, 2)],
    ["Debt / Equity", fmt(f.debtToEquity, 2)],
    ["Free cash flow", cr(f.freeCashflow)],
    ["52-w high", fmt(f.fiftyTwoWeekHigh)],
    ["52-w low", fmt(f.fiftyTwoWeekLow)],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="tab-content-fundamentals">
      {items.map(([k, v]) => (
        <div key={k} className="panel-elevated p-3">
          <div className="overline">{k}</div>
          <div className="font-mono text-[14px] mt-1">{v}</div>
        </div>
      ))}
    </div>
  );
}

function FnoTab({ d }) {
  const f = d.fno || {};
  const a = f.analytics || {};
  const kiteReason = (f.providers_tried || []).find((p) => p.provider === "kite")?.error || "";
  const notEligible = kiteReason.toLowerCase().includes("not f&o eligible");
  const sourceLabel = {
    upstox: "Upstox (broker)", fyers: "Fyers (broker)", nse: "NSE direct",
    yfinance: "yfinance", none: "unavailable",
  }[f.source] || f.source || "unknown";
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; } };

  if (!f.eligible) {
    return (
      <div className="flex flex-col gap-3" data-testid="tab-content-fno">
        <div className="panel-elevated p-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {notEligible && (
            <div className="mb-3 text-[13px]" style={{ color: "var(--text-primary)" }}>
              This symbol is not F&amp;O eligible on NSE. Try RELIANCE, SBIN, HDFCBANK, ICICIBANK, INFY, or an index underlying.
            </div>
          )}
          <div className="text-[13px] mb-1" style={{ color: "var(--text-primary)" }}>
            F&amp;O data unavailable from free sources.
          </div>
          Indian option-chain data is not carried by yfinance and NSE blocks data-centre IPs.
          Add broker credentials in <b>Admin → Settings</b> to enable live F&amp;O:
          <ul className="mt-2 ml-4 list-disc">
            <li><code>UPSTOX_ACCESS_TOKEN</code> — preferred</li>
            <li><code>FYERS_CLIENT_ID</code> + <code>FYERS_ACCESS_TOKEN</code></li>
            <li><code>FNO_ENABLE_NSE_DIRECT=true</code> — only if using a residential proxy</li>
          </ul>
          {(f.providers_tried || []).length > 0 && (
            <div className="mt-3 text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
              Providers tried:
              {(f.providers_tried || []).map((p, i) => (
                <div key={i}>  · {p.provider}: {p.error || "no data"}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="tab-content-fno">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80" }}>
          F&amp;O source: {sourceLabel}
        </span>
        {f.fetched_at && (
          <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            fetched {fmtTime(f.fetched_at)}
          </span>
        )}
        {a.bias && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                style={{
                  background: a.bias === "bullish" ? "rgba(74,222,128,0.14)"
                           : a.bias === "bearish" ? "rgba(248,113,113,0.14)"
                           : "rgba(250,204,21,0.12)",
                  color: a.bias === "bullish" ? "#4ade80"
                       : a.bias === "bearish" ? "#f87171" : "#facc15",
                }}>
            Bias: {a.bias} · conf {Math.round((a.confidence || 0) * 100)}%
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="panel-elevated p-3"><div className="overline">Underlying</div><div className="font-mono text-[14px] mt-1">₹{fmt(f.underlying)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">Total Call OI</div><div className="font-mono text-[14px] mt-1">{fmt(a.total_call_oi, 0)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">Total Put OI</div><div className="font-mono text-[14px] mt-1">{fmt(a.total_put_oi, 0)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">PCR</div><div className="font-mono text-[14px] mt-1">{fmt(a.pcr, 3)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">ATM strike</div><div className="font-mono text-[14px] mt-1">{fmt(a.atm_strike, 0)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">Max-OI Call (resistance)</div><div className="font-mono text-[14px] mt-1">{fmt(a.max_oi_call_strike, 0)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">Max-OI Put (support)</div><div className="font-mono text-[14px] mt-1">{fmt(a.max_oi_put_strike, 0)}</div></div>
        <div className="panel-elevated p-3"><div className="overline">Nearest expiry</div><div className="font-mono text-[14px] mt-1">{a.nearest_expiry || "—"}</div></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="overline mb-1">Top Calls by OI</div>
          <table className="w-full text-[12px] font-mono">
            <thead><tr style={{ color: "var(--text-muted)" }}><th className="text-left">Strike</th><th>OI</th><th>LTP</th><th>IV</th></tr></thead>
            <tbody>{(a.top_calls || []).map((c, i) => (
              <tr key={i}><td>{fmt(c.strike, 0)}</td><td className="text-right">{fmt(c.oi, 0)}</td><td className="text-right">{fmt(c.ltp)}</td><td className="text-right">{fmt(c.iv, 1)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div>
          <div className="overline mb-1">Top Puts by OI</div>
          <table className="w-full text-[12px] font-mono">
            <thead><tr style={{ color: "var(--text-muted)" }}><th className="text-left">Strike</th><th>OI</th><th>LTP</th><th>IV</th></tr></thead>
            <tbody>{(a.top_puts || []).map((c, i) => (
              <tr key={i}><td>{fmt(c.strike, 0)}</td><td className="text-right">{fmt(c.oi, 0)}</td><td className="text-right">{fmt(c.ltp)}</td><td className="text-right">{fmt(c.iv, 1)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NewsTab({ d }) {
  const items = d.news || [];
  if (!items.length) return <div className="text-[12px]" style={{ color: "var(--text-muted)" }} data-testid="tab-content-news">No headlines available.</div>;
  const sentItems = (d.sentiment?.items || []);
  const sentByTitle = Object.fromEntries(sentItems.map((s) => [s.title, s]));
  return (
    <div className="flex flex-col gap-2" data-testid="tab-content-news">
      {items.map((n, i) => {
        const s = sentByTitle[n.title];
        const score = s?.sentiment;
        const tone = score == null ? null : score > 0.2 ? "#4ade80" : score < -0.2 ? "#f87171" : "var(--text-muted)";
        return (
          <a key={i} href={n.link || "#"} target="_blank" rel="noreferrer"
             className="panel-elevated p-3 hover:bg-[var(--surface-elevated)] transition-colors block"
             data-testid={`news-item-${i}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="text-[13px] flex-1">{n.title}</div>
              {score != null && <span className="text-[10px] font-mono whitespace-nowrap" style={{ color: tone }}>{score.toFixed(2)}</span>}
            </div>
            <div className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              {n.source || "yfinance"} · {n.published || ""}
            </div>
          </a>
        );
      })}
    </div>
  );
}

function EventsTab({ d }) {
  const ev = d.events || {};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="tab-content-events">
      <div>
        <div className="overline mb-2">Next earnings</div>
        <div className="panel-elevated p-3 text-[13px] font-mono">
          {ev.next_earnings || <span style={{ color: "var(--text-muted)" }}>Not announced</span>}
        </div>
        <div className="overline mb-2 mt-4">Corporate actions</div>
        {(ev.actions || []).length === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No upcoming actions found.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {ev.actions.map((a, i) => (
              <div key={i} className="panel-elevated p-2 text-[12px] font-mono">
                <div>{a.subject || a.purpose || a.type}</div>
                <div style={{ color: "var(--text-muted)" }}>Ex-date: {a.ex_date || a.exDate || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="overline mb-2">Recent announcements</div>
        {(ev.announcements || []).length === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No recent NSE announcements.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {ev.announcements.map((a, i) => (
              <a key={i} href={a.attachment || "#"} target="_blank" rel="noreferrer"
                 className="panel-elevated p-2 text-[12px] hover:bg-[var(--surface-elevated)]">
                <div>{a.subject || a.desc}</div>
                <div className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {a.broadcastDate || a.date || ""}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreTab({ d }) {
  const s = d.score || {};
  const subs = [
    ["Technical", s.technical], ["Fundamental", s.fundamental],
    ["Valuation", s.valuation], ["Ownership", s.ownership],
    ["Analyst", s.analyst], ["Event/News", s.event_news],
    ["Macro/Sector", s.macro_sector],
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="tab-content-score">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {subs.map(([k, v]) => (
          <div key={k} className="panel-elevated p-3">
            <div className="overline">{k}</div>
            <div className="font-mono text-[14px] mt-1">{fmt(v, 1)}</div>
            <div className="h-[4px] rounded-full mt-2 overflow-hidden" style={{ background: "var(--bg)" }}>
              <div style={{ width: `${v || 0}%`, height: "100%", background: "linear-gradient(90deg, var(--accent-1), var(--accent-2))" }} />
            </div>
          </div>
        ))}
      </div>
      {d.ai_summary && (
        <div className="panel-elevated p-4 text-[13px] leading-relaxed whitespace-pre-line" data-testid="ai-summary">
          {d.ai_summary}
        </div>
      )}
      {!d.ai_summary && (
        <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          AI memo not generated for this fetch (skip_llm). Use "Refresh with AI" to generate.
        </div>
      )}
    </div>
  );
}

// ---------- Page ----------
export default function StockDeepDive() {
  const [pick, setPick] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("overview");
  const [withAI, setWithAI] = useState(true);
  const [chartInterval, setChartInterval] = useState("1d");

  const runFetch = async (sym, opts = {}) => {
    if (!sym) return;
    setLoading(true); setError(null);
    try {
      const { data } = await api.post(`/stocks/${sym}/deep-dive`,
        { skip_llm: !withAI, force_refresh: !!opts.force, interval: opts.interval || chartInterval });
      setData(data);
      if (!opts.keepTab) setTab("overview");
    } catch (e) {
      setError(e?.response?.data?.detail || "Fetch failed");
      toast.error(e?.response?.data?.detail || "Deep dive failed");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (pick?.symbol) runFetch(pick.symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);

  const onPick = (r) => setPick(r);
  const changeInterval = (interval) => {
    setChartInterval(interval);
    if (data?.symbol) runFetch(data.symbol, { force: true, interval, keepTab: true });
  };

  return (
    <div className="px-6 py-6 flex flex-col gap-5" data-testid="stock-deep-dive-page">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[28px] leading-tight">Stock Deep Dive</h1>
          <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Search any NSE EQ stock — live quote, technicals, fundamentals, F&amp;O, news, events and an AI verdict.
          </div>
        </div>
        <SearchBar onPick={onPick} />
      </div>

      {!data && !loading && !error && (
        <div className="panel p-6 text-center text-[12px]" style={{ color: "var(--text-muted)" }} data-testid="deepdive-empty-state">
          Start typing a symbol or company name above (e.g. SBIN, RELIANCE, TCS, HINDZINC).
        </div>
      )}

      {loading && (
        <div className="panel p-6 flex items-center gap-3" data-testid="deepdive-loading">
          <Loader2 size={18} className="animate-spin" />
          <div className="flex-1">
            <div className="font-mono text-[14px] font-bold flex items-center gap-2">
              {pick?.symbol || ""}
              {pick?.sector && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                      style={{ background: "var(--surface-elevated)", color: "var(--text-muted)" }}>
                  {pick.sector}
                </span>
              )}
            </div>
            {pick?.name && (
              <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{pick.name}</div>
            )}
            <div className="text-[12px] mt-1">Fetching latest quote, technicals, news, events and scoring…</div>
          </div>
        </div>
      )}

      {error && (
        <div className="panel p-4 flex items-center gap-2 text-[13px]" style={{ color: "#f87171" }} data-testid="deepdive-error">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {data && !loading && (
        <div className="panel p-5 flex flex-col gap-4" data-testid="deepdive-content">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
                {data.sector} · {data.industry} {data.from_cache && <span className="ml-2 px-2 py-0.5 rounded-full text-[10px]" style={{ background: "var(--surface-elevated)" }}>cached</span>}
              </div>
              <div className="font-heading text-[24px]">{data.name}</div>
              <div className="font-mono text-[14px]"><b>{data.symbol}</b> <span style={{ color: "var(--text-muted)" }}>· ₹{fmt(data.technicals?.last_close)}</span></div>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                <input type="checkbox" checked={withAI} onChange={(e) => setWithAI(e.target.checked)} data-testid="deepdive-ai-toggle" />
                AI memo
              </label>
              <button className="btn btn-outline text-[12px]" onClick={() => runFetch(data.symbol, { force: true })} data-testid="deepdive-refresh">
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>

          <TabHeader tab={tab} setTab={setTab} />
          <div className="pt-2">
            {tab === "overview" && <OverviewTab d={data} />}
            {tab === "chart" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    Chart source: {(data.chart_source || "unknown").toUpperCase()} · Interval: {(data.chart_label || chartInterval).toUpperCase()}
                  </div>
                  <div className="flex gap-1" data-testid="chart-intervals">
                    {["1m", "5m", "15m", "1h", "1d"].map((it) => (
                      <button
                        key={it}
                        className="font-mono text-[11px] px-2 py-1 rounded-sm border"
                        onClick={() => changeInterval(it)}
                        style={{
                          borderColor: chartInterval === it ? "var(--text-primary)" : "var(--border)",
                          color: chartInterval === it ? "var(--text-primary)" : "var(--text-muted)",
                          background: chartInterval === it ? "var(--surface-elevated)" : "transparent",
                        }}
                        data-testid={`chart-interval-${it}`}
                      >
                        {it}
                      </button>
                    ))}
                  </div>
                </div>
                <PriceChart ohlc={data.ohlc} />
              </div>
            )}
            {tab === "technicals" && <TechnicalsTab d={data} />}
            {tab === "fno" && <FnoTab d={data} />}
            {tab === "news" && <NewsTab d={data} />}
            {tab === "events" && <EventsTab d={data} />}
            {tab === "fundamentals" && <FundamentalsTab d={data} />}
            {tab === "score" && <ScoreTab d={data} />}
          </div>
        </div>
      )}
    </div>
  );
}
