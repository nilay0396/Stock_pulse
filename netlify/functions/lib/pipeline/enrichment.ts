import { db } from "../db.js";
import type { MacroPoint } from "../market/yahoo.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseDate(value: unknown): number | null {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  const t = new Date(`${text}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

function daysUntil(value: unknown): number | null {
  const t = parseDate(value);
  if (t === null) return null;
  const now = new Date(`${todayIst()}T00:00:00Z`).getTime();
  return Math.ceil((t - now) / 86400000);
}

function isPositiveAnnouncement(text: string): boolean {
  const lower = text.toLowerCase();
  return ["order", "contract", "award", "buyback", "bonus", "split", "dividend", "acquisition", "approval"].some((k) => lower.includes(k));
}

function isRiskAnnouncement(text: string): boolean {
  const lower = text.toLowerCase();
  return ["resignation", "default", "downgrade", "penalty", "litigation", "search", "seizure", "fraud", "delay"].some((k) => lower.includes(k));
}

async function rowsBySymbol(table: string, symbols: string[], select = "*", limit = 1000): Promise<Record<string, Dict[]>> {
  if (!symbols.length) return {};
  const { data, error } = await db.from(table).select(select).in("symbol", symbols).limit(limit);
  if (error) {
    console.warn(`official-data: ${table} unavailable:`, error.message);
    return {};
  }
  const out: Record<string, Dict[]> = {};
  for (const row of ((data || []) as Dict[])) (out[row.symbol] ||= []).push(row);
  return out;
}

export async function loadOfficialData(symbols: string[]): Promise<Record<string, Dict>> {
  const unique = [...new Set(symbols.filter(Boolean).map((s) => s.toUpperCase()))];
  const [bhav, announcements, actions, shareholding, insider, results] = await Promise.all([
    rowsBySymbol("bhavcopy_rows", unique, "*", 3000),
    rowsBySymbol("corp_announcements", unique, "*", 3000),
    rowsBySymbol("corp_actions", unique, "*", 2000),
    rowsBySymbol("shareholding_filings", unique, "*", 2000),
    rowsBySymbol("insider_trades", unique, "*", 3000),
    rowsBySymbol("financial_results", unique, "*", 2000),
  ]);

  const out: Record<string, Dict> = {};
  for (const symbol of unique) {
    const latestBhav = [...(bhav[symbol] || [])].sort((a, b) => String(b.as_of || "").localeCompare(String(a.as_of || "")))[0] || null;
    const ann = announcements[symbol] || [];
    const acts = actions[symbol] || [];
    const ins = insider[symbol] || [];
    const res = results[symbol] || [];
    const sh = shareholding[symbol] || [];
    const upcomingResultRows = (res as Dict[])
      .map((r) => ({ ...r, days: daysUntil(r.bm_date) }))
      .filter((r) => r.days !== null && r.days >= 0)
      .sort((a, b) => Number(a.days) - Number(b.days));
    const upcomingResult: Dict | null = upcomingResultRows[0] || null;
    const upcomingActions = acts
      .map((r) => ({ ...r, days: daysUntil(r.ex_date) }))
      .filter((r) => r.days !== null && r.days >= 0 && r.days <= 45)
      .sort((a, b) => Number(a.days) - Number(b.days));
    const promoterBuys = ins
      .filter((r) => String(r.tx_type || "").toLowerCase().includes("buy") || String(r.acquirer || "").toLowerCase().includes("promoter"))
      .reduce((sum, r) => sum + Number(r.value || 0), 0);
    const insiderSells = ins
      .filter((r) => String(r.tx_type || "").toLowerCase().includes("sell"))
      .reduce((sum, r) => sum + Number(r.value || 0), 0);
    const annText = ann.slice(0, 8).map((r) => `${r.subject || ""} ${r.description || ""}`).join(" ");

    out[symbol] = {
      bhav: latestBhav,
      announcements: ann.slice(0, 8),
      actions: upcomingActions.slice(0, 8),
      shareholding: sh.slice(0, 4),
      insider: {
        rows: ins.slice(0, 8),
        promoter_buys: promoterBuys,
        sells: insiderSells,
        buys: promoterBuys,
      },
      financial_results: res.slice(0, 4),
      next_earnings: upcomingResult?.bm_date || null,
      earnings_in_days: upcomingResult?.days ?? null,
      positive_event_count: ann.filter((r) => isPositiveAnnouncement(`${r.subject || ""} ${r.description || ""}`)).length,
      risk_event_count: ann.filter((r) => isRiskAnnouncement(`${r.subject || ""} ${r.description || ""}`)).length,
      event_text: annText,
      data_sources: {
        bhavcopy: Boolean(latestBhav),
        announcements: ann.length,
        corporate_actions: acts.length,
        shareholding: sh.length,
        insider: ins.length,
        financial_results: res.length,
      },
    };
  }
  return out;
}

export async function loadLatestFlows(): Promise<{ fiiNetCr: number | null; diiNetCr: number | null }> {
  const { data } = await db
    .from("fii_dii_flows")
    .select("*")
    .order("ingested_at", { ascending: false })
    .limit(20);
  const latestByCat = new Map<string, Dict>();
  for (const row of data || []) {
    const cat = String(row.category || "").toLowerCase();
    if (!latestByCat.has(cat)) latestByCat.set(cat, row);
  }
  return {
    fiiNetCr: Number(latestByCat.get("fii")?.net_value ?? latestByCat.get("fpi")?.net_value) || null,
    diiNetCr: Number(latestByCat.get("dii")?.net_value) || null,
  };
}

export type MarketRegime = {
  label: "risk_on_trend" | "risk_off" | "volatile_chop" | "range_bound";
  weeklyConvictionOffset: number;
  monthlyConvictionOffset: number;
  minTechnical: number;
  minFundamental: number;
  notes: string[];
};

export function classifyMarketRegime(macro: Record<string, MacroPoint>, niftySeries: (number | null)[]): MarketRegime {
  const vix = macro.INDIAVIX?.last ?? null;
  const nifty1m = macro.NIFTY?.change_pct ?? 0;
  const global = ["SP500", "NASDAQ", "NIKKEI", "HANGSENG"]
    .map((k) => macro[k]?.change_pct)
    .filter((x): x is number => x !== null && x !== undefined);
  const globalAvg = global.length ? global.reduce((a, b) => a + b, 0) / global.length : 0;
  const closes = niftySeries.filter((x): x is number => x !== null);
  const aboveTrend = closes.length >= 50 ? closes[closes.length - 1] > closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : nifty1m > 0;

  if ((vix && vix >= 20) || (nifty1m < -1.5 && globalAvg < 0)) {
    return { label: "risk_off", weeklyConvictionOffset: 4, monthlyConvictionOffset: 3, minTechnical: 74, minFundamental: 72, notes: ["Risk-off regime: require higher confirmation and tighter idea count."] };
  }
  if (vix && vix >= 16) {
    return { label: "volatile_chop", weeklyConvictionOffset: 3, monthlyConvictionOffset: 1, minTechnical: 73, minFundamental: 70, notes: ["Volatile/choppy regime: avoid marginal breakouts."] };
  }
  if (aboveTrend && nifty1m >= 0 && globalAvg >= -0.3) {
    return { label: "risk_on_trend", weeklyConvictionOffset: -1, monthlyConvictionOffset: -1, minTechnical: 70, minFundamental: 70, notes: ["Risk-on trend: normal idea thresholds."] };
  }
  return { label: "range_bound", weeklyConvictionOffset: 2, monthlyConvictionOffset: 1, minTechnical: 72, minFundamental: 70, notes: ["Range-bound market: prefer pullbacks and high-quality fundamentals."] };
}

export async function loadPerformanceCalibration(): Promise<Dict> {
  const { data, error } = await db
    .from("recommendation_lifecycle")
    .select("trade_idea_id, sector, horizon, direction, status, return_pct")
    .in("status", ["hit_target", "hit_stop", "hit_trailing_stop", "expired"])
    .limit(1000);
  if (error || !data?.length) return { sample: 0, thresholdOffset: 0, notes: ["No lifecycle history yet; calibration neutral."] };
  const closed = data || [];
  const ideaIds = closed.map((r) => r.trade_idea_id).filter(Boolean);
  const { data: ideas } = ideaIds.length
    ? await db.from("trade_ideas").select("id,setup_type,market_regime,ai_review").in("id", ideaIds)
    : { data: [] };
  const ideaMap = new Map((ideas || []).map((i) => [i.id, i as Dict]));
  const avg = closed.reduce((s, r) => s + Number(r.return_pct || 0), 0) / closed.length;
  const hitRate = closed.filter((r) => Number(r.return_pct || 0) > 0).length / closed.length;
  const thresholdOffset = closed.length < 30 ? 1 : hitRate < 0.45 || avg < 0 ? 3 : hitRate > 0.58 && avg > 1 ? -1 : 0;

  const buckets: Record<string, Dict[]> = {};
  const add = (name: string, key: unknown, row: Dict) => {
    const value = String(key || "Unknown");
    (buckets[`${name}:${value}`] ||= []).push(row);
  };
  for (const row of closed as Dict[]) {
    const idea = ideaMap.get(row.trade_idea_id) || {};
    const confidence = Number(idea.ai_review?.confidence ?? 0);
    add("sector", row.sector, row);
    add("horizon", row.horizon, row);
    add("direction", row.direction, row);
    add("setup", idea.setup_type, row);
    add("regime", idea.market_regime, row);
    add("ai_confidence", confidence >= 0.75 ? "high" : confidence >= 0.55 ? "medium" : confidence > 0 ? "low" : "unknown", row);
  }

  const adjustments: Record<string, number> = {};
  for (const [key, rows] of Object.entries(buckets)) {
    if (rows.length < 5) continue;
    const bucketAvg = rows.reduce((s, r) => s + Number(r.return_pct || 0), 0) / rows.length;
    const bucketHit = rows.filter((r) => Number(r.return_pct || 0) > 0).length / rows.length;
    const raw = bucketHit >= 0.62 && bucketAvg > 0.75 ? 2 : bucketHit >= 0.55 && bucketAvg > 0 ? 1 : bucketHit <= 0.42 || bucketAvg < -0.5 ? -2 : bucketHit < 0.48 || bucketAvg < 0 ? -1 : 0;
    if (raw !== 0) adjustments[key] = raw;
  }

  return {
    sample: closed.length,
    hit_rate_pct: Math.round(hitRate * 10000) / 100,
    avg_return_pct: Math.round(avg * 1000) / 1000,
    thresholdOffset,
    adjustments,
    notes: [`Lifecycle calibration sample=${closed.length}, hit-rate=${Math.round(hitRate * 100)}%, avg=${Math.round(avg * 100) / 100}%.`],
  };
}

export function calibrationAdjustment(calibration: Dict, idea: Dict, regimeLabel: string): number {
  const adjustments = calibration?.adjustments || {};
  const review = idea.ai_review || {};
  const confidence = Number(review.confidence ?? 0);
  const confidenceBucket = confidence >= 0.75 ? "high" : confidence >= 0.55 ? "medium" : confidence > 0 ? "low" : "unknown";
  const keys = [
    `sector:${idea.sector || "Unknown"}`,
    `horizon:${idea.horizon || "Unknown"}`,
    `direction:${idea.direction || "Unknown"}`,
    `setup:${idea.setup_type || "Unknown"}`,
    `regime:${regimeLabel || "Unknown"}`,
    `ai_confidence:${confidenceBucket}`,
  ];
  const total = keys.reduce((sum, key) => sum + Number(adjustments[key] || 0), 0);
  return Math.max(-5, Math.min(5, total));
}
