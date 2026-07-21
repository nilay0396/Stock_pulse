/**
 * End-to-end daily report pipeline — faithful port of
 * backend/services/report.py::generate_report, adapted to cloud-safe data
 * sources (Kite + yahoo-finance2 + RSS + FMP; no NSE-website connectors)
 * and Supabase persistence. Runs on GitHub Actions, not in a Netlify
 * function.
 *
 * 3-stage funnel:
 *   Stage 1 (wide, cheap, no LLM): universe -> Kite-quote liquidity gate ->
 *     yahoo OHLC for survivors -> lightweight technicals -> shortlist ~200.
 *   Stage 2 (shortlist): yahoo quoteSummary "info", FMP fundamentals, RSS news.
 *   Stage 3 (LLM, final): strict scoring -> idea selection -> per-idea
 *     rationale + narrative -> persist report_runs/trade_ideas/stock_scores.
 *
 * NSE-only inputs (bhavcopy, FII/DII, insider, corp actions, earnings
 * calendar) are absent on cloud IPs; the scoring engine defaults their
 * sub-scores to neutral 50, so the report still generates.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { computeSnapshot, type OhlcvBar, type Series } from "../scoring/indicators.js";
import * as scoring from "../scoring/scoring.js";
import type { SubScoreKey } from "../scoring/scoring.js";
import { lightweightSetupScore, rankAndShortlist } from "../scoring/prefilter.js";
import { sectorImpactScores } from "../scoring/commodityMapping.js";
import { fetchMacro, fetchEquityOhlc, fetchQuoteSummaryInfo, type MacroPoint } from "../market/yahoo.js";
import { fetchRssNews, rssBySymbol, type RssItem } from "../connectors/rssNews.js";
import { fetchFmpFundamentals, type FmpFundamental } from "../connectors/fmp.js";
import {
  scoreNewsBatch,
  generateIdeaReview,
  generateIdeaRationale,
  generateReportNarrative,
  fallbackRationale,
  fallbackNarrative,
  getLlmUsage,
  llmAvailable,
  resetLlmUsage,
} from "../llm/anthropic.js";
import { loadUniverse, type UniverseRow } from "./universe.js";
import { getAuthenticatedKiteClient } from "../kite/client.js";
import { fetchOptionChain } from "../kite/optionChain.js";
import { deliverReport } from "../delivery/deliverReport.js";
import { sendOpsAlert } from "../delivery/opsAlert.js";
import { createLifecycleRowsForIdeas, updateRecommendationLifecycle } from "./lifecycle.js";
import { calibrationAdjustment, classifyMarketRegime, loadLatestFlows, loadOfficialData, loadPerformanceCalibration, type MarketRegime } from "./enrichment.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

const WEEKLY_HOLD_DAYS = 10;
const MONTHLY_HOLD_DAYS = 35;
const EXPORT_SECTORS = new Set(["IT", "Pharma", "Chemicals"]);

export interface RunOptions {
  skipLlm?: boolean;
  skipDelivery?: boolean;
  universeLimit?: number;
  force?: boolean;
  triggeredBy?: string;
}

function todayIstStr(): string {
  // IST = UTC+5:30, no DST.
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Kite-quote liquidity gate (Stage 1) — cheap batch replacement for bhavcopy.
// Best-effort: if Kite is unavailable, returns null and the caller skips the
// gate (all pool names proceed to OHLC).
// ---------------------------------------------------------------------------
async function kiteLiquidityGate(
  pool: UniverseRow[],
  minPrice = 50,
  minTurnoverCr = 1.0,
): Promise<Set<string> | null> {
  let kc;
  try {
    kc = await getAuthenticatedKiteClient();
  } catch (err) {
    console.warn("liquidity-gate: Kite unavailable, skipping gate:", err instanceof Error ? err.message : err);
    return null;
  }
  const survivors = new Set<string>();
  const BATCH = 400;
  try {
    for (let i = 0; i < pool.length; i += BATCH) {
      const chunk = pool.slice(i, i + BATCH);
      const keys = chunk.map((u) => `NSE:${u.symbol}`);
      const quotes = await kc.getQuote(keys);
      for (const u of chunk) {
        const q = quotes[`NSE:${u.symbol}`];
        if (!q) continue;
        const price = q.last_price ?? 0;
        const turnoverCr = ((q.volume ?? 0) * (q.average_price ?? price)) / 1e7;
        if (price >= minPrice && turnoverCr >= minTurnoverCr) survivors.add(u.symbol);
      }
    }
  } catch (err) {
    console.warn("liquidity-gate: Kite quote batch failed, skipping gate:", err instanceof Error ? err.message : err);
    return null;
  }
  return survivors;
}

function macroClosesSeries(macro: Record<string, MacroPoint>): Series {
  const nifty = macro.NIFTY;
  if (!nifty || !nifty.history) return [];
  return nifty.history.map((h) => h.close);
}

function computeSectorBreadth(rows: Dict[]): Record<string, number> {
  const agg: Record<string, number[]> = {};
  for (const r of rows) {
    const s = r.sector || "Other";
    const c = r.change_pct_1m;
    if (c === null || c === undefined) continue;
    (agg[s] ||= []).push(c);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(agg)) {
    if (v.length) out[k] = round(v.reduce((a, b) => a + b, 0) / v.length, 2);
  }
  return out;
}

function buildSnapshots(pool: UniverseRow[], hist: Record<string, OhlcvBar[]>, niftySeries: Series): Dict[] {
  const now = new Date().toISOString();
  const snapshots: Dict[] = [];
  for (const u of pool) {
    const bars = hist[u.symbol];
    if (!bars || bars.length === 0) continue;
    const snap = computeSnapshot(bars, niftySeries.length ? niftySeries : undefined);
    if (!snap || Object.keys(snap).length === 0) continue;
    snapshots.push({ ...snap, symbol: u.symbol, sector: u.sector, name: u.name, as_of: now });
  }
  return snapshots;
}

function buildSectorPeerArrays(
  snapshots: Dict[],
  universeBySym: Record<string, UniverseRow>,
  infoCache: Record<string, Dict>,
  fmpData: Record<string, FmpFundamental>,
): { peBy: Record<string, number[]>; pbBy: Record<string, number[]>; evBy: Record<string, number[]> } {
  const peBy: Record<string, number[]> = {};
  const pbBy: Record<string, number[]> = {};
  const evBy: Record<string, number[]> = {};
  for (const snap of snapshots) {
    const sym = snap.symbol;
    const sec = universeBySym[sym]?.sector || "Other";
    const info = infoCache[sym] || {};
    if (info.trailingPE !== null && info.trailingPE !== undefined) (peBy[sec] ||= []).push(info.trailingPE);
    if (info.priceToBook !== null && info.priceToBook !== undefined) (pbBy[sec] ||= []).push(info.priceToBook);
    const ev = (fmpData[sym]?.metrics_ttm || {}).enterpriseValueOverEBITDATTM;
    if (ev !== null && ev !== undefined) (evBy[sec] ||= []).push(ev);
  }
  return { peBy, pbBy, evBy };
}

function computeRawScores(
  snapshots: Dict[],
  macro: Record<string, MacroPoint>,
  infoCache: Record<string, Dict>,
  fmpData: Record<string, FmpFundamental>,
  newsSentiment: Record<string, Dict>,
  universeBySym: Record<string, UniverseRow>,
  sectorBreadth: Record<string, number>,
  commoditySector: Record<string, number>,
  peBy: Record<string, number[]>,
  pbBy: Record<string, number[]>,
  evBy: Record<string, number[]>,
  officialData: Record<string, Dict>,
  flows: { fiiNetCr: number | null; diiNetCr: number | null },
): Dict[] {
  const vix = macro.INDIAVIX?.last ?? null;
  const usdinrChg = macro.USDINR?.change_pct ?? null;
  const dxyChg = macro.DXY?.change_pct ?? null;
  const glChanges = ["SP500", "NASDAQ", "NIKKEI", "HANGSENG", "FTSE"]
    .map((k) => macro[k]?.change_pct)
    .filter((x): x is number => x !== null && x !== undefined);
  const globalAvgChg = glChanges.length ? glChanges.reduce((a, b) => a + b, 0) / glChanges.length : null;

  const out: Dict[] = [];
  for (const snap of snapshots) {
    const symbol = snap.symbol;
    const info = infoCache[symbol] || {};
    const fmpRow = fmpData[symbol] || null;
    const official = officialData[symbol] || {};
    const sector = snap.sector;
    const uniRow = universeBySym[symbol] || {};

    const { passes, rejects } = scoring.applyHardFilters(snap, uniRow, official.bhav || null, null, 50.0, 1.0);

    const tech = scoring.scoreTechnical(snap);
    const fund = scoring.scoreFundamentals(info, (fmpRow as unknown) as Dict);
    const val = scoring.scoreValuation(info, (fmpRow as unknown) as Dict, peBy[sector] || [], pbBy[sector] || [], evBy[sector] || []);
    const own = scoring.scoreOwnership(info, official.bhav || null, official.insider || null, flows.fiiNetCr, flows.diiNetCr);
    const an = scoring.scoreAnalyst(info, (fmpRow as unknown) as Dict);
    const ns = newsSentiment[symbol] || { avg_sentiment: 0.0, items: [] };
    const eventSentimentBoost = Math.max(-0.4, Math.min(0.4, 0.12 * Number(official.positive_event_count || 0) - 0.18 * Number(official.risk_event_count || 0)));
    const news = scoring.scoreEventNews(
      Math.max(-1, Math.min(1, (ns.avg_sentiment ?? 0.0) + eventSentimentBoost)),
      (ns.items || []).length + Number(official.positive_event_count || 0) + Number(official.risk_event_count || 0),
      official.actions || null,
    );
    const macroScore = scoring.scoreMacroSector(
      sector,
      sectorBreadth,
      vix,
      usdinrChg,
      dxyChg,
      commoditySector[sector] ?? 0.0,
      globalAvgChg,
      EXPORT_SECTORS.has(sector),
    );

    const rawSub: Partial<Record<SubScoreKey, number>> = {
      technical: tech.score,
      fundamental: fund.score,
      valuation: val.score,
      ownership: own.score,
      analyst: an.score,
      event_news: news.score,
      macro_sector: macroScore.score,
    };
    const reasons = [...tech.reasons, ...fund.reasons, ...val.reasons, ...an.reasons, ...news.reasons, ...macroScore.reasons];
    const risks = [...rejects];
    if ((snap.volatility_20 || 0) > 40) risks.push("Elevated volatility");
    if (info.debtToEquity && info.debtToEquity > 150) risks.push("High leverage");
    if (vix && vix > 20) risks.push("Elevated INDIAVIX");
    if (official.earnings_in_days !== null && official.earnings_in_days !== undefined && official.earnings_in_days <= 7) {
      risks.push(`Results/board meeting in ${official.earnings_in_days} days`);
    }
    if (official.risk_event_count > 0) risks.push("Recent exchange filing risk event");

    out.push({ symbol, snap, info, official, earnings_in_days: official.earnings_in_days ?? null, next_earnings: official.next_earnings ?? null, passes, rejects, raw_sub: rawSub, reasons, risks });
  }
  return out;
}

async function buildScoreDocs(rawRows: Dict[], runDate: string, runId: string): Promise<Dict[]> {
  const penalised = rawRows.map((row) => scoring.applyEarningsPenalty(row.raw_sub, row.earnings_in_days ?? null));
  const normSubs = scoring.normalizeSubscoresUniverse(penalised);
  const nowIso = new Date().toISOString();
  const setupMap: Record<string, string> = {
    breakout: "breakout",
    pullback: "pullback",
    range: "accumulation",
    downtrend: "event-led",
    neutral: "neutral",
  };

  const out: Dict[] = [];
  const rows: Dict[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const norm = normSubs[i];
    const snap = row.snap;
    const conv = scoring.finalConviction(norm);
    let [direction] = scoring.classifyTrade(conv, norm.technical ?? 50, norm.fundamental ?? 50, norm.macro_sector ?? 50);
    if (!row.passes) direction = "avoid";

    const doc = {
      id: randomUUID(),
      symbol: row.symbol,
      as_of: nowIso,
      report_run_id: runId,
      technical: round(norm.technical ?? 50, 2),
      fundamental: round(norm.fundamental ?? 50, 2),
      valuation: round(norm.valuation ?? 50, 2),
      ownership: round(norm.ownership ?? 50, 2),
      analyst: round(norm.analyst ?? 50, 2),
      event_news: round(norm.event_news ?? 50, 2),
      macro_sector: round(norm.macro_sector ?? 50, 2),
      conviction: conv,
      direction,
      reasons: row.reasons.slice(0, 10),
      risks: row.risks.slice(0, 6),
      setup_type: setupMap[snap.setup || "neutral"] || "neutral",
      sector: snap.sector,
      name: snap.name,
      official_data: row.official,
      next_earnings: row.next_earnings,
      earnings_in_days: row.earnings_in_days,
      // fields used downstream by _select_ideas but not columns in stock_scores:
      _last_close: snap.last_close,
      _passes_filters: row.passes,
    };
    out.push(doc);
    rows.push({
      id: doc.id,
      symbol: doc.symbol,
      as_of: doc.as_of,
      report_run_id: runId,
      technical: doc.technical,
      fundamental: doc.fundamental,
      valuation: doc.valuation,
      ownership: doc.ownership,
      analyst: doc.analyst,
      event_news: doc.event_news,
      macro_sector: doc.macro_sector,
      conviction: doc.conviction,
      direction: doc.direction,
      reasons: doc.reasons,
      risks: doc.risks,
      setup_type: doc.setup_type,
    });
  }
  if (rows.length) {
    const { error } = await db.from("stock_scores").insert(rows);
    if (error) throw new Error(`stock_scores insert failed: ${error.message}`);
  }
  return out;
}

function selectIdeas(
  scores: Dict[],
  snapshots: Dict[],
  runId: string,
  hist: Record<string, OhlcvBar[]>,
  regime: MarketRegime,
  calibration: Dict,
): { weekly: Dict[]; monthly: Dict[]; excluded: Dict[]; relaxed: boolean } {
  const snapMap: Record<string, Dict> = {};
  for (const s of snapshots) snapMap[s.symbol] = s;

  const weeklyGate = 72 + regime.weeklyConvictionOffset + Number(calibration.thresholdOffset || 0);
  const monthlyGate = 75 + regime.monthlyConvictionOffset + Number(calibration.thresholdOffset || 0);
  const effectiveConviction = (s: Dict, horizon: "weekly" | "monthly") => {
    const adjustment = calibrationAdjustment(calibration, { ...s, horizon }, regime.label);
    return round(Number(s.conviction || 0) + adjustment, 2);
  };
  const qualifiesWeekly = (s: Dict) => s._passes_filters && effectiveConviction(s, "weekly") >= weeklyGate && s.technical >= regime.minTechnical;
  const qualifiesMonthly = (s: Dict) => s._passes_filters && effectiveConviction(s, "monthly") >= monthlyGate && s.fundamental >= regime.minFundamental && s.macro_sector >= 65;

  const weeklyQual: Dict[] = [];
  const monthlyQual: Dict[] = [];
  for (const s of scores) {
    if (qualifiesWeekly(s)) weeklyQual.push(s);
    if (qualifiesMonthly(s)) monthlyQual.push(s);
  }
  weeklyQual.sort((a, b) => effectiveConviction(b, "weekly") - effectiveConviction(a, "weekly"));
  monthlyQual.sort((a, b) => effectiveConviction(b, "monthly") - effectiveConviction(a, "monthly"));

  const mk = (scoreDoc: Dict, horizon: string): Dict => {
    const snap = snapMap[scoreDoc.symbol] || {};
    const levels = scoring.structureAwareEntryStopTarget(snap.last_close || 100.0, snap.atr_14 ?? null, scoreDoc.direction, horizon, hist[scoreDoc.symbol] || []);
    const performanceAdjustment = calibrationAdjustment(calibration, { ...scoreDoc, horizon }, regime.label);
    return {
      id: randomUUID(),
      report_run_id: runId,
      symbol: scoreDoc.symbol,
      name: scoreDoc.name,
      sector: scoreDoc.sector,
      direction: scoreDoc.direction,
      horizon,
      setup_type: scoreDoc.setup_type,
      conviction: scoreDoc.conviction,
      effective_conviction: round(Number(scoreDoc.conviction || 0) + performanceAdjustment, 2),
      performance_adjustment: performanceAdjustment,
      ...levels,
      reasons: scoreDoc.reasons.slice(0, 6),
      risks: scoreDoc.risks.slice(0, 4),
      official_data: scoreDoc.official_data,
      next_earnings: scoreDoc.next_earnings,
      earnings_in_days: scoreDoc.earnings_in_days,
      market_regime: regime.label,
      sub_scores: {
        technical: scoreDoc.technical,
        fundamental: scoreDoc.fundamental,
        valuation: scoreDoc.valuation,
        ownership: scoreDoc.ownership,
        analyst: scoreDoc.analyst,
        event_news: scoreDoc.event_news,
        macro_sector: scoreDoc.macro_sector,
      },
      created_at: new Date().toISOString(),
    };
  };

  const weekly = weeklyQual.slice(0, 8).map((s) => mk(s, "weekly"));
  const monthly = monthlyQual.slice(0, 8).map((s) => mk(s, "monthly"));

  if (weekly.length || monthly.length) {
    return {
      weekly,
      monthly,
      excluded: [],
      relaxed: false,
    };
  }

  const fallback = scores
    .filter((s) => s._last_close !== null && s._last_close !== undefined)
    .sort((a, b) => {
      const aScore = (a.conviction ?? 0) + 0.25 * (a.technical ?? 0);
      const bScore = (b.conviction ?? 0) + 0.25 * (b.technical ?? 0);
      return bScore - aScore;
    })
    .slice(0, 5)
    .map((s) => {
      const idea = mk({ ...s, direction: "watch" }, "weekly");
      idea.reasons = [
        "Watchlist candidate: strict weekly/monthly thresholds produced no trade ideas",
        ...idea.reasons,
      ].slice(0, 6);
      idea.risks = [...(s._passes_filters ? [] : ["Did not pass all hard trade filters"]), ...idea.risks].slice(0, 4);
      return idea;
    });

  return {
    weekly: fallback,
    monthly: [],
    excluded: [],
    relaxed: fallback.length > 0,
  };
}

function buildContext(
  runDate: string,
  runId: string,
  macro: Record<string, MacroPoint>,
  scores: Dict[],
  sectorBreadth: Record<string, number>,
  commoditySector: Record<string, number>,
  weekly: Dict[],
  monthly: Dict[],
  universeCount: number,
  marketRegime?: MarketRegime,
  performanceCalibration?: Dict,
  flows?: { fiiNetCr: number | null; diiNetCr: number | null },
): Dict {
  const sortedSectors = Object.entries(sectorBreadth).sort((a, b) => b[1] - a[1]);
  const bullish = sortedSectors.slice(0, 3).filter(([, v]) => v > 0).map(([s]) => s);
  const cautious = sortedSectors.slice(-3).filter(([, v]) => v < 0).map(([s]) => s);
  const bearish = scores.filter((s) => (s.direction === "bearish" || s.direction === "avoid") && s.conviction <= 40).slice(0, 8);
  const vix = macro.INDIAVIX?.last ?? null;

  return {
    run_date: runDate,
    run_id: runId,
    macro,
    sector_breadth: sectorBreadth,
    bullish_sectors: bullish,
    cautious_sectors: cautious,
    top_weekly: weekly,
    top_monthly: monthly,
    excluded_by_earnings: [],
    bearish_watch: bearish.map((s) => ({ symbol: s.symbol, conviction: s.conviction })),
    universe_count: universeCount,
    scored_count: scores.length,
    fii_net_cr: flows?.fiiNetCr ?? null,
    dii_net_cr: flows?.diiNetCr ?? null,
    market_regime: marketRegime,
    performance_calibration: performanceCalibration,
    commodity_impact: commoditySector,
    risks: [
      vix ? `INDIAVIX at ${vix.toFixed(1)}` : "Volatility regime",
      "FII flow dependency",
      "Global macro overhang",
    ],
  };
}

function analyseFnoChain(chain: Dict): Dict {
  const calls = Array.isArray(chain.calls) ? chain.calls : [];
  const puts = Array.isArray(chain.puts) ? chain.puts : [];
  const totalCallOi = calls.reduce((s: number, c: Dict) => s + Number(c.oi || 0), 0);
  const totalPutOi = puts.reduce((s: number, p: Dict) => s + Number(p.oi || 0), 0);
  const callOiChange = calls.reduce((s: number, c: Dict) => s + Number(c.change_oi || 0), 0);
  const putOiChange = puts.reduce((s: number, p: Dict) => s + Number(p.change_oi || 0), 0);
  const ivs = [...calls, ...puts].map((c: Dict) => Number(c.iv)).filter((v: number) => Number.isFinite(v) && v > 0);
  const byOi = (a: Dict, b: Dict) => Number(b.oi || 0) - Number(a.oi || 0);
  const maxCall = [...calls].sort(byOi)[0] || {};
  const maxPut = [...puts].sort(byOi)[0] || {};
  const pcr = totalCallOi ? totalPutOi / totalCallOi : null;
  const changePcr = callOiChange ? putOiChange / callOiChange : null;
  const maxPain = maxCall.strike && maxPut.strike ? round((Number(maxCall.strike) + Number(maxPut.strike)) / 2, 2) : null;
  return {
    eligible: true,
    source: chain.source || "kite",
    underlying: chain.underlying,
    nearest_expiry: chain.expiries?.[0] ?? null,
    total_call_oi: totalCallOi,
    total_put_oi: totalPutOi,
    call_oi_change: callOiChange,
    put_oi_change: putOiChange,
    pcr,
    change_pcr: changePcr,
    avg_iv: ivs.length ? round(ivs.reduce((s: number, v: number) => s + v, 0) / ivs.length, 2) : null,
    max_oi_call_strike: maxCall.strike ?? null,
    max_oi_put_strike: maxPut.strike ?? null,
    max_pain_proxy: maxPain,
    bias: pcr == null ? "neutral" : pcr > 1.15 ? "bullish" : pcr < 0.85 ? "bearish" : "neutral",
  };
}

async function attachFnoAnalytics(ideas: Dict[]): Promise<void> {
  if (!ideas.length) return;
  let kc;
  try {
    kc = await getAuthenticatedKiteClient();
  } catch (err) {
    for (const idea of ideas) idea.fno = { eligible: false, source: "kite", error: err instanceof Error ? err.message : String(err) };
    return;
  }
  await Promise.all(ideas.map(async (idea) => {
    const chain = await fetchOptionChain(kc, idea.symbol);
    idea.fno = chain.eligible ? analyseFnoChain(chain as unknown as Dict) : { eligible: false, source: "kite", error: chain.error };
    if (idea.fno.eligible && idea.fno.bias && idea.fno.bias !== "neutral") {
      idea.reasons = [`F&O ${idea.fno.bias} PCR ${Number(idea.fno.pcr || 0).toFixed(2)}`, ...(idea.reasons || [])].slice(0, 6);
      if (idea.direction === "bullish" && idea.fno.bias === "bearish") {
        idea.conviction = Math.max(0, round(Number(idea.conviction || 0) - 3, 2));
        idea.risks = ["F&O OI/PCR bias conflicts with bullish setup", ...(idea.risks || [])].slice(0, 5);
      } else if (idea.direction === "bearish" && idea.fno.bias === "bullish") {
        idea.conviction = Math.max(0, round(Number(idea.conviction || 0) - 3, 2));
        idea.risks = ["F&O OI/PCR bias conflicts with bearish setup", ...(idea.risks || [])].slice(0, 5);
      } else if (idea.direction === idea.fno.bias) {
        idea.conviction = Math.min(100, round(Number(idea.conviction || 0) + 1, 2));
      }
    }
  }));
}

async function applyFinalIdeaReview(
  ideas: Dict[],
  context: Dict,
  skipLlm: boolean,
): Promise<{ approved: Dict[]; rejected: Dict[] }> {
  const approved: Dict[] = [];
  const rejected: Dict[] = [];
  for (const idea of ideas) {
    const review = skipLlm
      ? await generateIdeaReview(idea, { ...context, force_fallback: true })
      : await generateIdeaReview(idea, context);
    idea.ai_review = review;
    if (review.approved) {
      approved.push(idea);
    } else {
      rejected.push({
        symbol: idea.symbol,
        horizon: idea.horizon,
        conviction: idea.conviction,
        reason: review.reason,
        red_flags: review.red_flags,
      });
    }
  }
  return { approved, rejected };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------
export async function generateReport(opts: RunOptions = {}): Promise<Dict> {
  const skipLlm = opts.skipLlm ?? false;
  resetLlmUsage();
  const triggeredBy = opts.triggeredBy ?? "github-actions";
  const runDate = todayIstStr();
  const runId = randomUUID();
  const tStart = Date.now();

  // Idempotency / catch-up guard.
  if (!opts.force) {
    const { data: existing } = await db
      .from("report_runs")
      .select("id")
      .eq("run_date", runDate)
      .eq("status", "success")
      .limit(1)
      .maybeSingle();
    if (existing) {
      console.log(`report: a successful run already exists for ${runDate} (${existing.id}); skipping (use --force to override).`);
      return { id: existing.id, status: "skipped_existing" };
    }
  }

  await db.from("report_runs").insert({
    id: runId,
    run_date: runDate,
    started_at: new Date().toISOString(),
    status: "running",
    triggered_by: triggeredBy,
    summary: {},
    narrative: "",
  });

  try {
    const universe = await loadUniverse();
    if (!universe.length) throw new Error("Stock universe empty. Seed it first.");
    const pool0 = opts.universeLimit ? universe.slice(0, opts.universeLimit) : universe;

    // ---- STAGE 1: macro + liquidity gate + OHLC + lightweight rank ----
    const t1 = Date.now();
    const macro = await fetchMacro();
    const commoditySector = sectorImpactScores(macro);
    const niftySeries = macroClosesSeries(macro);

    const survivors = await kiteLiquidityGate(pool0);
    const pool = survivors ? pool0.filter((u) => survivors.has(u.symbol)) : pool0;
    console.log(`funnel | universe=${pool0.length} pool=${pool.length} (kite_gate=${survivors ? "on" : "off"})`);

    const hist = await fetchEquityOhlc(pool.map((u) => u.symbol));
    const universeBySym: Record<string, UniverseRow> = {};
    for (const u of universe) universeBySym[u.symbol] = u;

    const snapshotsLite = buildSnapshots(pool, hist, niftySeries);
    const [shortlisted, liteRankRows] = rankAndShortlist(snapshotsLite, universeBySym as unknown as Record<string, Dict>, 200);
    const shortlistedSyms = new Set(shortlisted.map((u) => u.symbol));
    const snapshots = snapshotsLite.filter((s) => shortlistedSyms.has(s.symbol));
    console.log(`funnel | ohlc=${Object.keys(hist).length} snapshots=${snapshotsLite.length} shortlisted=${snapshots.length}`);

    // Persist technical snapshots for the shortlist.
    if (snapshots.length) {
      const techRows = snapshots.map((s) => ({
        symbol: s.symbol,
        as_of: s.as_of,
        last_close: s.last_close ?? null,
        change_pct_1d: s.change_pct_1d ?? null,
        change_pct_1w: s.change_pct_1w ?? null,
        change_pct_1m: s.change_pct_1m ?? null,
        rsi_14: s.rsi_14 ?? null,
        sma_20: s.sma_20 ?? null,
        sma_50: s.sma_50 ?? null,
        sma_100: s.sma_100 ?? null,
        sma_200: s.sma_200 ?? null,
        ema_20: s.ema_20 ?? null,
        ema_50: s.ema_50 ?? null,
        macd: s.macd ?? null,
        macd_signal: s.macd_signal ?? null,
        macd_hist: s.macd_hist ?? null,
        bb_upper: s.bb_upper ?? null,
        bb_lower: s.bb_lower ?? null,
        bb_mid: s.bb_mid ?? null,
        atr_14: s.atr_14 ?? null,
        volatility_20: s.volatility_20 ?? null,
        volume_spike: s.volume_spike ?? null,
        volume_avg_20: s.volume_avg_20 ?? null,
        relative_strength: s.relative_strength ?? null,
        setup: s.setup ?? null,
      }));
      const { error } = await db.from("technical_snapshots").upsert(techRows, { onConflict: "symbol" });
      if (error) console.warn("technical_snapshots upsert warning:", error.message);
    }
    const sectorBreadth = computeSectorBreadth(snapshots);
    const stage1Seconds = round((Date.now() - t1) / 1000, 1);

    // ---- STAGE 2: deep enrich (info, FMP, RSS news) on shortlist ----
    const t2 = Date.now();
    const shortlistUniverse = shortlisted;
    const infoCache = await fetchQuoteSummaryInfo(shortlistUniverse.map((u) => u.symbol));
    const fmpData = await fetchFmpFundamentals(shortlistUniverse.map((u) => u.symbol));
    const officialData = await loadOfficialData(shortlistUniverse.map((u) => u.symbol));
    const flows = await loadLatestFlows();

    const rssItems = await fetchRssNews(shortlistUniverse);
    const rssMap = rssBySymbol(rssItems);
    const newsSentiment = await computeNewsSentiment(snapshots, rssMap, runDate, skipLlm);
    const stage2Seconds = round((Date.now() - t2) / 1000, 1);

    // ---- STAGE 3: strict scoring + idea selection + narrative ----
    const t3 = Date.now();
    const { peBy, pbBy, evBy } = buildSectorPeerArrays(snapshots, universeBySym, infoCache, fmpData);
    const marketRegime = classifyMarketRegime(macro, niftySeries);
    const performanceCalibration = await loadPerformanceCalibration();
    const rawRows = computeRawScores(snapshots, macro, infoCache, fmpData, newsSentiment, universeBySym, sectorBreadth, commoditySector, peBy, pbBy, evBy, officialData, flows);
    const scores = await buildScoreDocs(rawRows, runDate, runId);
    const selected = selectIdeas(scores, snapshots, runId, hist, marketRegime, performanceCalibration);
    let weekly = selected.weekly;
    let monthly = selected.monthly;
    const { excluded, relaxed } = selected;
    let followups: Dict = {
      checked: 0,
      active_count: 0,
      resolved_count: 0,
      active: [],
      resolved: [],
    };
    try {
      followups = await updateRecommendationLifecycle();
      console.log(`lifecycle | checked=${followups.checked || 0} active=${followups.active_count || 0} resolved=${followups.resolved_count || 0}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("lifecycle warning:", message);
      followups = {
        checked: 0,
        active_count: 0,
        resolved_count: 0,
        active: [],
        resolved: [],
        error: message,
      };
    }
    const stage3Seconds = round((Date.now() - t3) / 1000, 1);

    // AI final review + rationales + narrative.
    const preReviewContext = buildContext(runDate, runId, macro, scores, sectorBreadth, commoditySector, weekly, monthly, universe.length, marketRegime, performanceCalibration, flows);
    preReviewContext.followups = followups;
    await attachFnoAnalytics([...weekly, ...monthly]);
    const weeklyReview = await applyFinalIdeaReview(weekly, preReviewContext, skipLlm);
    const monthlyReview = await applyFinalIdeaReview(monthly, preReviewContext, skipLlm);
    weekly = weeklyReview.approved;
    monthly = monthlyReview.approved;
    const aiRejected = [...weeklyReview.rejected, ...monthlyReview.rejected];
    const ctxDraft = buildContext(runDate, runId, macro, scores, sectorBreadth, commoditySector, weekly, monthly, universe.length, marketRegime, performanceCalibration, flows);
    ctxDraft.followups = followups;
    ctxDraft.ai_rejected_ideas = aiRejected;
    await attachRationales([...weekly, ...monthly], ctxDraft, skipLlm);

    if (weekly.length || monthly.length) {
      const ideaRows = [...weekly, ...monthly].map((x) => ({
        id: x.id,
        report_run_id: runId,
        symbol: x.symbol,
        name: x.name,
        sector: x.sector,
        direction: x.direction,
        horizon: x.horizon,
        setup_type: x.setup_type,
        conviction: x.conviction,
        entry_low: x.entry_low,
        entry_high: x.entry_high,
        stop_loss: x.stop_loss,
        target_low: x.target_low,
        target_high: x.target_high,
        risk_reward: x.risk_reward,
        construction: x.construction,
        market_regime: x.market_regime,
        next_earnings: x.next_earnings,
        earnings_in_days: x.earnings_in_days,
        ai_review: x.ai_review || {},
        fno: x.fno || {},
        reasons: x.reasons,
        risks: x.risks,
        created_at: x.created_at,
      }));
      const { error } = await db.from("trade_ideas").insert(ideaRows);
      if (error) throw new Error(`trade_ideas insert failed: ${error.message}`);
      await createLifecycleRowsForIdeas([...weekly, ...monthly], runDate);
    }

    // Persist news items (shortlist headlines).
    if (rssItems.length) {
      const newsRows = rssItems.slice(0, 200).map((it: RssItem) => ({
        symbol: it.matched_symbols[0] || null,
        headline: it.title,
        source: it.source,
        url: it.link,
        sentiment: null,
        category: it.scope,
        published_at: null,
        ingested_at: it.ingested_at,
      }));
      const { error } = await db.from("news_items").insert(newsRows);
      if (error) console.warn("news_items insert warning:", error.message);
    }

    const funnelStats = {
      universe_total: universe.length,
      pool: pool.length,
      ohlc_returned: Object.keys(hist).length,
      ranked: liteRankRows.length,
      shortlisted: snapshots.length,
      scored: scores.length,
      weekly_ideas: weekly.length,
      monthly_ideas: monthly.length,
      relaxed_ideas: relaxed,
      no_idea_reason:
        weekly.length || monthly.length
          ? null
          : aiRejected.length
            ? "Candidate ideas were found but rejected by AI/risk review."
            : scores.length === 0
            ? "No stocks reached Stage 3 scoring. Check universe, OHLC, snapshot and shortlist counts."
            : "Stocks were scored, but neither strict nor fallback idea selection produced candidates.",
      excluded_by_earnings: excluded.length,
      ai_rejected_ideas: aiRejected.length,
      kite_gate: Boolean(survivors),
      market_regime: marketRegime.label,
      calibration_offset: performanceCalibration.thresholdOffset || 0,
      llm_usage: getLlmUsage(),
      total_seconds: round((Date.now() - tStart) / 1000, 1),
      stage1_seconds: stage1Seconds,
      stage2_seconds: stage2Seconds,
      stage3_seconds: stage3Seconds,
    };
    const context = buildContext(runDate, runId, macro, scores, sectorBreadth, commoditySector, weekly, monthly, universe.length, marketRegime, performanceCalibration, flows);
    context.funnel = funnelStats;
    context.followups = followups;
    context.ai_rejected_ideas = aiRejected;
    const narrative = skipLlm ? fallbackNarrative(context) : await generateReportNarrative(context);
    funnelStats.llm_usage = getLlmUsage();
    context.narrative = narrative;

    // Persist report_runs. `summary` carries the sub-keys the read routes
    // expect (funnel, excluded_by_earnings, lite_rank_top, macro).
    const { macro: _macro, ...summaryNoMacro } = context;
    void _macro;
    const macroSnapshot: Dict = {};
    for (const [k, v] of Object.entries(macro)) {
      const { history, ...rest } = v;
      void history;
      macroSnapshot[k] = rest;
    }
    const { error: updErr } = await db
      .from("report_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "success",
        summary: {
          ...summaryNoMacro,
          macro: macroSnapshot,
          funnel: funnelStats,
          lite_rank_top: liteRankRows.slice(0, 300),
        },
        narrative,
      })
      .eq("id", runId);
    if (updErr) throw new Error(`report_runs update failed: ${updErr.message}`);

    console.log(`report: success ${runId} — weekly=${weekly.length} monthly=${monthly.length} in ${funnelStats.total_seconds}s`);
    if (!opts.skipDelivery) {
      try {
        const delivery = await deliverReport(runId);
        console.log("delivery result:", JSON.stringify(delivery));
        if (delivery.failed > 0 || delivery.sent + delivery.dry_run === 0) {
          await sendOpsAlert(
            "Report delivery degraded",
            `Run ${runId} completed, but delivery result was ${JSON.stringify(delivery)}.`,
          );
        }
      } catch (err) {
        console.warn("delivery warning:", err instanceof Error ? err.message : err);
        await sendOpsAlert("Report delivery failed", `Run ${runId} succeeded but delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { id: runId, status: "success", funnel: funnelStats };
  } catch (err) {
    console.error("report: failed:", err instanceof Error ? err.stack || err.message : err);
    await db
      .from("report_runs")
      .update({ status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() })
      .eq("id", runId);
    await sendOpsAlert("Report pipeline failed", `Run ${runId} failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    return { id: runId, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

// Per-symbol news sentiment from RSS-matched headlines (+ LLM unless skipLlm).
async function computeNewsSentiment(
  snapshots: Dict[],
  rssMap: Record<string, RssItem[]>,
  runDate: string,
  skipLlm: boolean,
): Promise<Record<string, Dict>> {
  const out: Record<string, Dict> = {};
  const now = new Date().toISOString();
  void runDate;
  void now;
  for (const snap of snapshots) {
    const symbol = snap.symbol;
    const items = rssMap[symbol] || [];
    if (skipLlm || items.length === 0) {
      out[symbol] = { avg_sentiment: 0.0, items };
    } else {
      out[symbol] = await scoreNewsBatch(symbol, items);
    }
  }
  return out;
}

async function attachRationales(ideas: Dict[], context: Dict, skipLlm: boolean): Promise<void> {
  if (!ideas.length) return;
  if (skipLlm || !llmAvailable()) {
    for (const i of ideas) i.rationale = fallbackRationale(i);
    return;
  }
  await Promise.all(
    ideas.map(async (i) => {
      try {
        const r = await generateIdeaRationale(i, context);
        i.rationale = r && r.trim() ? r.trim() : fallbackRationale(i);
      } catch {
        i.rationale = fallbackRationale(i);
      }
    }),
  );
}
