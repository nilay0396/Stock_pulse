/**
 * Market Pulse India — multi-factor scoring engine.
 * Ported 1:1 from backend/services/scoring.py — see that file's module
 * docstring for the conceptual model. This port preserves every formula,
 * threshold, and Python-specific quirk noted inline (falsy-vs-null checks,
 * `or`-chaining on raw values, etc.) rather than "fixing" them, per the
 * Phase 2 plan's numeric-parity decision.
 *
 * Final Score = 0.22*Technical + 0.20*Fundamental + 0.10*Valuation +
 *               0.10*Ownership + 0.08*Analyst + 0.18*Event/News + 0.12*Macro/Sector
 */

// ====================================================================
// Final weights (must sum to 1.00)
// ====================================================================
export const FINAL_WEIGHTS = {
  technical: 0.22,
  fundamental: 0.2,
  valuation: 0.1,
  ownership: 0.1,
  analyst: 0.08,
  event_news: 0.18,
  macro_sector: 0.12,
} as const;

export type SubScoreKey = keyof typeof FINAL_WEIGHTS;

const TECHNICAL_WEIGHTS = { TR: 20, MO: 15, RSI: 15, BB: 10, MACD: 10, VOL: 10, ATR: 10, REL: 10 };
const FUND_WEIGHTS = { GR: 20, PR: 15, CF: 15, DE: 10, IC: 10, RO: 10, MG: 10, BS: 10 };
const VAL_WEIGHTS = { PE: 35, PB: 20, EV: 20, PEG: 15, DY: 10 };
const OWN_WEIGHTS = { FI: 25, DI: 20, PH: 20, PR: 15, VL: 20 };
const AN_WEIGHTS = { RT: 35, TP: 25, ER: 20, CV: 20 };
const NEWS_WEIGHTS = { SE: 30, IM: 25, RE: 20, FR: 15, TM: 10 };
const MACRO_WEIGHTS = { SR: 30, VX: 20, FX: 20, CM: 15, GL: 15 };

function assertSumsTo100(name: string, weights: Record<string, number>) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum !== 100) throw new Error(`${name} components must sum to 100, got ${sum}`);
}
{
  const finalSum = Object.values(FINAL_WEIGHTS).reduce((a, b) => a + b, 0);
  if (Math.abs(finalSum - 1.0) >= 1e-9) throw new Error("FINAL_WEIGHTS must sum to 1.0");
  assertSumsTo100("TECHNICAL", TECHNICAL_WEIGHTS);
  assertSumsTo100("FUND", FUND_WEIGHTS);
  assertSumsTo100("VAL", VAL_WEIGHTS);
  assertSumsTo100("OWN", OWN_WEIGHTS);
  assertSumsTo100("AN", AN_WEIGHTS);
  assertSumsTo100("NEWS", NEWS_WEIGHTS);
  assertSumsTo100("MACRO", MACRO_WEIGHTS);
}

// ====================================================================
// Generic helpers
// ====================================================================
function clip(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Coerce arbitrary upstream values to a clean float, or null. Mirrors
 * Python's `_num()` including the bool guard and the empty-string trap
 * (JS's `Number("")` is 0, not NaN — must be handled explicitly). */
function num(x: unknown): number | null {
  if (x === null || x === undefined || typeof x === "boolean") return null;
  if (typeof x === "number") return Number.isNaN(x) ? null : x;
  if (typeof x === "string") {
    const trimmed = x.trim();
    if (trimmed === "") return null;
    const f = Number(trimmed);
    return Number.isNaN(f) ? null : f;
  }
  return null;
}

export function percentileRank(
  values: unknown[],
  v: unknown,
  higherIsBetter = true,
): number {
  const nv = num(v);
  if (nv === null) return 50.0;
  const clean = values.map(num).filter((n): n is number => n !== null);
  if (clean.length === 0) return 50.0;
  const below = clean.filter((x) => x < nv).length;
  const equal = clean.filter((x) => x === nv).length;
  const p = ((below + 0.5 * equal) / clean.length) * 100;
  return higherIsBetter ? p : 100 - p;
}

export function linear(x: unknown, lo: number, hi: number, invert = false): number {
  const nx = num(x);
  if (nx === null) return 50.0;
  if (hi === lo) return 50.0;
  let t = (nx - lo) / (hi - lo);
  t = Math.max(0.0, Math.min(1.0, t));
  return invert ? (1 - t) * 100 : t * 100;
}

export function band(x: unknown, idealLo: number, idealHi: number, decay = 20.0): number {
  const nx = num(x);
  if (nx === null) return 50.0;
  if (nx >= idealLo && nx <= idealHi) return 100.0;
  const dist = nx < idealLo ? idealLo - nx : nx - idealHi;
  return clip(100 - (dist / decay) * 100);
}

/** Convert yfinance-style ratios (sometimes fraction, sometimes %) to percent. */
function pct(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Math.abs(n) < 5 ? n * 100 : n;
}

function fmt(x: number, decimals: number): string {
  return x.toFixed(decimals);
}
function fmtSigned(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return x >= 0 ? `+${s}` : s;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

// ====================================================================
// TECHNICAL = 20TR + 15MO + 15RSI + 10BB + 10MACD + 10VOL + 10ATR + 10REL
// ====================================================================
function compTrend(s: Dict): number {
  const last = s.last_close || 0;
  const sma20 = s.sma_20 || 0;
  const sma50 = s.sma_50 || 0;
  const sma100 = s.sma_100 || 0;
  const sma200 = s.sma_200 || 0;
  let score = 0;
  for (const sma of [sma20, sma50, sma100, sma200]) {
    if (sma && last > sma) score += 16;
  }
  if (sma50 && sma200 && sma50 > sma200) score += 20;
  if (sma20 && sma50 && sma200 && sma20 > sma50 && sma50 > sma200) score += 16;
  return clip(score);
}

function compMomentum(s: Dict): number {
  const w = s.change_pct_1w || 0;
  const m = s.change_pct_1m || 0;
  return 0.5 * linear(w, -10, 10) + 0.5 * linear(m, -20, 20);
}

function compRsi(s: Dict): number {
  const r = s.rsi_14;
  if (r === null || r === undefined) return 50.0;
  if (r >= 50 && r <= 65) return 100.0;
  if (r >= 40 && r < 50) return 80.0;
  if (r > 65 && r <= 72) return 75.0;
  if (r >= 30 && r < 40) return 55.0;
  if (r > 72 && r <= 78) return 50.0;
  if (r > 78) return clip(100 - (r - 78) * 6);
  if (r < 30) return clip(30 - (30 - r) * 4);
  return 50.0;
}

function compBb(s: Dict): number {
  const last = s.last_close || 0;
  const up = s.bb_upper;
  const lo = s.bb_lower;
  const mid = s.bb_mid;
  if (!(up && lo && mid && last)) return 50.0;
  const width = up - lo;
  if (width <= 0) return 50.0;
  const pos = (last - lo) / width;
  if (pos >= 0.55 && pos <= 0.85) return 100.0;
  if (pos > 0.85 && pos <= 1.0) return 85.0;
  if (pos > 1.0 && pos <= 1.1) return 70.0;
  if (pos >= 0.4 && pos < 0.55) return 70.0;
  if (pos >= 0.2 && pos < 0.4) return 55.0;
  if (pos > 1.1) return clip(70 - (pos - 1.1) * 150);
  return clip(40 * pos);
}

function compMacd(s: Dict): number {
  const hist = s.macd_hist;
  const macdVal = s.macd;
  if (hist === null || hist === undefined) return 50.0;
  let base = hist > 0 ? 60 : 40;
  const last = s.last_close || 0;
  const rel = last ? (Math.abs(hist) / last) * 100 : 0;
  base += hist > 0 ? Math.min(25, rel * 50) : -Math.min(25, rel * 50);
  if (macdVal !== null && macdVal !== undefined && macdVal > 0) base += 10;
  return clip(base);
}

function compVol(s: Dict): number {
  const spike = s.volume_spike || 1.0;
  if (spike >= 1.3 && spike <= 3.0) return 100.0;
  if (spike >= 1.0 && spike < 1.3) return 65.0;
  if (spike >= 0.7 && spike < 1.0) return 50.0;
  if (spike > 3.0 && spike <= 5.0) return 70.0;
  if (spike > 5.0) return clip(70 - (spike - 5.0) * 10);
  return clip(60 * spike);
}

function compAtr(s: Dict): number {
  const atrVal = s.atr_14;
  const last = s.last_close || 0;
  if (!(atrVal && last)) return 50.0;
  const ratio = (atrVal / last) * 100;
  return band(ratio, 1.5, 3.5, 3.0);
}

function compRel(s: Dict): number {
  const r = s.relative_strength || 0;
  return linear(r, -10, 10);
}

export function scoreTechnical(s: Dict): ScoreResult {
  const c = {
    TR: compTrend(s),
    MO: compMomentum(s),
    RSI: compRsi(s),
    BB: compBb(s),
    MACD: compMacd(s),
    VOL: compVol(s),
    ATR: compAtr(s),
    REL: compRel(s),
  };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (TECHNICAL_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (c.TR >= 80) reasons.push(`Strong multi-timeframe uptrend (TR ${fmt(c.TR, 0)})`);
  if (c.RSI >= 85) reasons.push(`RSI in sweet spot (${s.rsi_14})`);
  if (c.BB >= 85) reasons.push("Price in breakout half of Bollinger");
  if (c.MACD >= 70) reasons.push("MACD momentum positive");
  if (c.VOL >= 85) reasons.push(`Volume ${fmt(s.volume_spike ?? 1, 1)}x avg (accumulation)`);
  if (c.REL >= 70) reasons.push(`Outperforming NIFTY ${fmtSigned(s.relative_strength ?? 0, 1)}%`);
  if (c.TR <= 30) reasons.push("Below key moving averages");
  if (c.MACD <= 30) reasons.push("MACD momentum negative");
  return { score: clip(score), reasons };
}

// ====================================================================
// FUNDAMENTAL = 20GR + 15PR + 15CF + 10DE + 10IC + 10RO + 10MG + 10BS
// ====================================================================
export function scoreFundamentals(finIn: Dict | null, fmpIn: Dict | null = null): ScoreResult {
  const fin = finIn || {};
  const ratios = (fmpIn || {}).ratios_ttm || {};
  const metrics = (fmpIn || {}).metrics_ttm || {};

  const gr = pct(fin.revenueGrowth);
  const pr = pct(fin.earningsGrowth);
  const cfRaw = num(ratios.operatingCashFlowPerShareTTM || fin.operatingCashflow);
  const cf = cfRaw !== null && cfRaw > 0 ? 75.0 : 35.0;
  const de = num(fin.debtToEquity);
  const ic = num(ratios.interestCoverageTTM || ratios.interestCoverage);
  const ro = pct(fin.returnOnEquity);
  const mg = pct(fin.profitMargins) || pct(fin.operatingMargins);
  const cr = num(ratios.currentRatioTTM || ratios.currentRatio || fin.currentRatio);

  const c = {
    GR: linear(gr, -10, 30),
    PR: linear(pr, -15, 35),
    CF: cf,
    DE: linear(de, 200, 0),
    IC: linear(ic, 1, 10),
    RO: linear(ro, 0, 30),
    MG: linear(mg, 0, 25),
    BS: band(cr, 1.2, 3.0, 1.5),
  };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (FUND_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (gr !== null && gr > 15) reasons.push(`Revenue growth ${fmt(gr, 1)}%`);
  if (ro !== null && ro > 20) reasons.push(`ROE ${fmt(ro, 1)}%`);
  if (de !== null && de < 40) reasons.push(`Low leverage D/E ${fmt(de, 0)}`);
  if (ic !== null && ic > 6) reasons.push(`Interest coverage ${fmt(ic, 1)}x`);
  if (mg !== null && mg > 15) reasons.push(`Profit margin ${fmt(mg, 1)}%`);
  if (gr !== null && gr < 0) reasons.push(`Revenue contracting ${fmt(gr, 1)}%`);
  if (de !== null && de > 150) reasons.push(`High leverage D/E ${fmt(de, 0)}`);
  return { score: clip(score), reasons };
}

// ====================================================================
// VALUATION = 35PE + 20PB + 20EV + 15PEG + 10DY
// ====================================================================
export function scoreValuation(
  finIn: Dict | null,
  fmpIn: Dict | null = null,
  sectorPe: number[] | null = null,
  sectorPb: number[] | null = null,
  sectorEv: number[] | null = null,
): ScoreResult {
  const fin = finIn || {};
  const metrics = (fmpIn || {}).metrics_ttm || {};
  const pe = num(fin.trailingPE);
  const pb = num(fin.priceToBook);
  const ev = num(metrics.enterpriseValueOverEBITDATTM || metrics.enterpriseValueMultipleTTM);
  const peg = num(fin.pegRatio || metrics.pegRatioTTM);
  const dy = pct(fin.dividendYield);

  const pePct = percentileRank(sectorPe || [], pe, false);
  const pbPct = percentileRank(sectorPb || [], pb, false);
  const evPct = percentileRank(sectorEv || [], ev, false);

  const c = {
    PE: sectorPe && sectorPe.length > 0 ? pePct : band(pe, 10, 22, 20),
    PB: sectorPb && sectorPb.length > 0 ? pbPct : band(pb, 1, 4, 6),
    EV: sectorEv && sectorEv.length > 0 ? evPct : band(ev, 6, 15, 10),
    PEG: band(peg, 0.5, 1.5, 1.0),
    DY: linear(dy, 0, 5),
  };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (VAL_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (pe !== null && pe < 18) reasons.push(`Attractive P/E ${fmt(pe, 1)}`);
  if (pe !== null && pe > 55) reasons.push(`Rich P/E ${fmt(pe, 1)}`);
  if (ev !== null && ev < 10) reasons.push(`EV/EBITDA ${fmt(ev, 1)}`);
  if (peg !== null && peg > 0.5 && peg < 1.2) reasons.push(`Good PEG ${fmt(peg, 2)}`);
  if (dy !== null && dy > 3) reasons.push(`Dividend yield ${fmt(dy, 1)}%`);
  return { score: clip(score), reasons };
}

// ====================================================================
// OWNERSHIP = 25FI + 20DI + 20PH + 15PR + 20VL
// ====================================================================
export function scoreOwnership(
  finIn: Dict | null,
  bhavIn: Dict | null = null,
  insiderIn: Dict | null = null,
  fiiNetCr: number | null = null,
  diiNetCr: number | null = null,
): ScoreResult {
  const fin = finIn || {};
  const insider = insiderIn || {};
  const bhav = bhavIn || {};
  const ph = pct(fin.heldPercentInsiders);
  const institutions = pct(fin.heldPercentInstitutions);
  const promoterBuysCr = (insider.promoter_buys || 0) / 1e7;
  const netInsiderCr = ((insider.buys || 0) - (insider.sells || 0)) / 1e7;
  const delivPct = bhav.deliv_pct;

  const c: Record<"FI" | "DI" | "PH" | "PR" | "VL", number> = {
    FI: linear(fiiNetCr, -2000, 2000),
    DI: linear(diiNetCr, -2000, 2000),
    PH: linear(ph, 20, 70),
    PR: promoterBuysCr > 0 ? linear(promoterBuysCr, 0, 20) : linear(netInsiderCr, -10, 10),
    VL: linear(delivPct, 25, 75),
  };
  if (ph === null && institutions !== null) {
    c.PH = linear(institutions, 10, 55);
  }
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (OWN_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (promoterBuysCr > 0) reasons.push(`Promoter buy ₹${fmt(promoterBuysCr, 1)} Cr (30d)`);
  if (delivPct !== null && delivPct !== undefined && delivPct > 60)
    reasons.push(`High delivery ${fmt(delivPct, 0)}%`);
  if (delivPct !== null && delivPct !== undefined && delivPct < 25)
    reasons.push(`Speculative trade (deliv ${fmt(delivPct, 0)}%)`);
  if (fiiNetCr !== null && fiiNetCr !== undefined && fiiNetCr > 1000)
    reasons.push(`FII +₹${fmt(fiiNetCr, 0)} Cr`);
  if (fiiNetCr !== null && fiiNetCr !== undefined && fiiNetCr < -1000)
    reasons.push(`FII -₹${fmt(Math.abs(fiiNetCr), 0)} Cr`);
  return { score: clip(score), reasons };
}

// ====================================================================
// ANALYST = 35RT + 25TP + 20ER + 20CV
// ====================================================================
export function scoreAnalyst(finIn: Dict | null, fmpIn: Dict | null = null): ScoreResult {
  const fin = finIn || {};
  const rec = fin.recommendationMean;
  const tp = fin.targetMeanPrice;
  const cp = fin.currentPrice;
  const nAnalystsRaw: unknown = fin.numberOfAnalystOpinions || (fin.recommendationKey && 8);
  const estimates: Dict[] = (fmpIn || {}).estimates || [];

  const rtScore = linear(rec, 5, 1);
  const impliedUp = tp && cp && cp > 0 ? ((tp - cp) / cp) * 100 : null;
  const tpScore = linear(impliedUp, -10, 30);

  let erScore = 50.0;
  if (estimates.length >= 2) {
    const latest = (estimates[0] || {}).estimatedEpsAvg || 0;
    const prev = (estimates[1] || {}).estimatedEpsAvg || 0;
    if (latest && prev) {
      const delta = ((latest - prev) / prev) * 100;
      erScore = linear(delta, -10, 10);
    }
  }
  const cvInput = typeof nAnalystsRaw === "number" ? nAnalystsRaw : null;
  const cvScore = linear(cvInput, 1, 25);

  const c = { RT: rtScore, TP: tpScore, ER: erScore, CV: cvScore };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (AN_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (rec !== null && rec !== undefined && rec <= 2)
    reasons.push(`Analyst Buy consensus (mean ${fmt(rec, 1)})`);
  if (impliedUp !== null && impliedUp > 15) reasons.push(`Target implies ${fmt(impliedUp, 0)}% upside`);
  if (impliedUp !== null && impliedUp < -10)
    reasons.push(`Target implies ${fmt(Math.abs(impliedUp), 0)}% downside`);
  if (erScore > 65) reasons.push("EPS estimates revised up");
  if (erScore < 35) reasons.push("EPS estimates revised down");
  return { score: clip(score), reasons };
}

// ====================================================================
// NEWS / EVENT = 30SE + 25IM + 20RE + 15FR + 10TM
// ====================================================================
export function scoreEventNews(
  avgSentiment: number,
  headlineCount: number,
  upcomingActions: Dict[] | null = null,
  recencyHours: number | null = null,
  toneTrend: number | null = null,
): ScoreResult {
  if (!headlineCount) {
    let base = 50.0;
    for (const act of (upcomingActions || []).slice(0, 3)) {
      const subj = (act.subject || "").toLowerCase();
      if (subj.includes("buyback")) base = Math.min(100.0, base + 12);
      else if (subj.includes("bonus")) base = Math.min(100.0, base + 6);
      else if (subj.includes("split")) base = Math.min(100.0, base + 5);
      else if (subj.includes("dividend")) base = Math.min(100.0, base + 2);
    }
    const reasons: string[] = [];
    if (upcomingActions) {
      for (const act of upcomingActions.slice(0, 2)) {
        const subj: string = act.subject || "";
        if (["buyback", "bonus", "split", "dividend"].some((k) => subj.toLowerCase().includes(k))) {
          reasons.push(`${subj} (ex ${act.ex_date})`);
        }
      }
    }
    return { score: clip(base), reasons };
  }

  const se = linear(avgSentiment, -1.0, 1.0);
  const im = clip(Math.abs(avgSentiment) * 50 + Math.log1p(headlineCount || 0) * 12);
  const re = recencyHours !== null && recencyHours !== undefined ? linear(recencyHours, 72, 0) : 60.0;
  const fr = band(headlineCount, 3, 10, 5);
  let tm = toneTrend !== null && toneTrend !== undefined ? linear(toneTrend, -0.5, 0.5) : 50.0;
  for (const act of (upcomingActions || []).slice(0, 3)) {
    const subj = (act.subject || "").toLowerCase();
    if (subj.includes("buyback")) tm = Math.min(100, tm + 20);
    else if (subj.includes("bonus")) tm = Math.min(100, tm + 10);
    else if (subj.includes("split")) tm = Math.min(100, tm + 8);
    else if (subj.includes("dividend")) tm = Math.min(100, tm + 3);
  }

  const c = { SE: se, IM: im, RE: re, FR: fr, TM: tm };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (NEWS_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (avgSentiment > 0.3) reasons.push(`Positive news flow (${headlineCount} items)`);
  if (avgSentiment < -0.3) reasons.push(`Negative news flow (${headlineCount} items)`);
  if (upcomingActions) {
    for (const act of upcomingActions.slice(0, 2)) {
      const subj: string = act.subject || "";
      if (["buyback", "bonus", "split", "dividend"].some((k) => subj.toLowerCase().includes(k))) {
        reasons.push(`${subj} (ex ${act.ex_date})`);
      }
    }
  }
  return { score: clip(score), reasons };
}

// ====================================================================
// MACRO / SECTOR = 30SR + 20VX + 20FX + 15CM + 15GL
// ====================================================================
export function scoreMacroSector(
  sector: string,
  sectorBreadth: Record<string, number>,
  vix: number | null = null,
  usdinrChg: number | null = null,
  dxyChg: number | null = null,
  commodityImpact = 0.0,
  globalAvgChg: number | null = null,
  isExportSector = false,
): ScoreResult {
  const secVals = Object.values(sectorBreadth);
  const secVal = sectorBreadth[sector];
  const sr = secVals.length > 0 ? percentileRank(secVals, secVal) : 50.0;
  const vx = linear(vix, 30, 10);
  let fxBase = linear(usdinrChg, 1.0, -1.0);
  if (isExportSector) fxBase = 100 - fxBase;
  const dxyEffect = linear(dxyChg, 1.0, -1.0);
  const fx = 0.6 * fxBase + 0.4 * dxyEffect;
  const cm = clip(50 + commodityImpact * 3.3);
  const gl = linear(globalAvgChg, -1.0, 1.0);

  const c = { SR: sr, VX: vx, FX: fx, CM: cm, GL: gl };
  const score = (Object.keys(c) as (keyof typeof c)[]).reduce(
    (sum, k) => sum + (MACRO_WEIGHTS[k] * c[k]) / 100,
    0,
  );
  const reasons: string[] = [];
  if (sr >= 75) reasons.push(`Sector ${sector} leading the market`);
  else if (sr <= 25) reasons.push(`Sector ${sector} lagging`);
  if (vix !== null && vix !== undefined && vix < 13) reasons.push(`Benign VIX ${fmt(vix, 1)}`);
  if (vix !== null && vix !== undefined && vix > 20) reasons.push(`Elevated VIX ${fmt(vix, 1)}`);
  if (commodityImpact >= 3) reasons.push(`Commodity tailwind +${fmt(commodityImpact, 1)}`);
  if (commodityImpact <= -3) reasons.push(`Commodity headwind ${fmt(commodityImpact, 1)}`);
  return { score: clip(score), reasons };
}

// ====================================================================
// Earnings event-risk penalty
// ====================================================================
const EARNINGS_PENALTY_WINDOW_DAYS = 7;
const EARNINGS_PENALTY_FIELDS: SubScoreKey[] = ["technical", "event_news"];

export function applyEarningsPenalty(
  sub: Partial<Record<SubScoreKey, number>>,
  daysToEarnings: number | null,
  window: number = EARNINGS_PENALTY_WINDOW_DAYS,
): Partial<Record<SubScoreKey, number>> {
  if (daysToEarnings === null || daysToEarnings === undefined || daysToEarnings > window || window <= 0) {
    return sub;
  }
  const dampen = Math.max(0.0, Math.min(1.0, (window - Math.max(0, daysToEarnings)) / window));
  const out = { ...sub };
  for (const k of EARNINGS_PENALTY_FIELDS) {
    const v = sub[k];
    if (v === null || v === undefined) continue;
    const fv = Number(v);
    if (Number.isNaN(fv)) continue;
    out[k] = Math.round(clip(fv * (1 - dampen) + 50.0 * dampen) * 100) / 100;
  }
  return out;
}

// ====================================================================
// Hybrid universe normalization
// ====================================================================
const HYBRID_ALPHA: Record<SubScoreKey, number> = {
  technical: 0.35,
  fundamental: 0.5,
  valuation: 0.3,
  ownership: 0.45,
  analyst: 0.4,
  event_news: 0.35,
  macro_sector: 0.5,
};

export function normalizeSubscoresUniverse(
  allSubs: Partial<Record<SubScoreKey, number>>[],
): Partial<Record<SubScoreKey, number>>[] {
  if (!allSubs || allSubs.length === 0) return [];
  const byKey: Record<SubScoreKey, number[]> = {
    technical: [],
    fundamental: [],
    valuation: [],
    ownership: [],
    analyst: [],
    event_news: [],
    macro_sector: [],
  };
  for (const s of allSubs) {
    for (const k of Object.keys(byKey) as SubScoreKey[]) {
      const v = s[k];
      if (v === null || v === undefined) continue;
      const fv = Number(v);
      if (Number.isNaN(fv)) continue;
      byKey[k].push(fv);
    }
  }
  return allSubs.map((s) => {
    const out = { ...s };
    for (const k of Object.keys(HYBRID_ALPHA) as SubScoreKey[]) {
      const alpha = HYBRID_ALPHA[k];
      if (!(k in s) || s[k] === null || s[k] === undefined) continue;
      const raw = Number(s[k]);
      if (Number.isNaN(raw)) continue;
      if (alpha >= 0.999 || byKey[k].length === 0) {
        out[k] = Math.round(clip(raw) * 100) / 100;
        continue;
      }
      const p = percentileRank(byKey[k], raw, true);
      out[k] = Math.round(clip(alpha * raw + (1 - alpha) * p) * 100) / 100;
    }
    return out;
  });
}

// ====================================================================
// Final score + trade classification
// ====================================================================
export function finalConviction(sub: Partial<Record<SubScoreKey, number>>): number {
  const total = (Object.keys(FINAL_WEIGHTS) as SubScoreKey[]).reduce(
    (sum, k) => sum + FINAL_WEIGHTS[k] * (sub[k] ?? 50),
    0,
  );
  return Math.round(total * 100) / 100;
}

export type TradeDirection = "avoid" | "bullish" | "bearish" | "watch";
export type TradeHorizon = "both" | "monthly" | "weekly" | null;

export function classifyTrade(
  final: number,
  technical: number,
  fundamental: number,
  macroSector: number,
): [TradeDirection, TradeHorizon] {
  if (final <= 40) return ["avoid", null];
  const monthlyOk = final >= 75 && fundamental >= 70 && macroSector >= 65;
  const weeklyOk = final >= 72 && technical >= 70;
  if (monthlyOk && weeklyOk) return ["bullish", "both"];
  if (monthlyOk) return ["bullish", "monthly"];
  if (weeklyOk) return ["bullish", "weekly"];
  if (final <= 48 && technical <= 45) return ["bearish", null];
  return ["watch", null];
}

// ====================================================================
// Hard filters
// ====================================================================
export interface HardFilterResult {
  passes: boolean;
  rejects: string[];
}

export function applyHardFilters(
  snapshot: Dict,
  universeRow: Dict,
  bhav: Dict | null,
  riskFlags: string[] | null = null,
  minPrice = 50.0,
  minTurnoverCr = 1.0,
  minMarketCapTier: "large" | "mid" | "small" = "small",
): HardFilterResult {
  const rejects: string[] = [];
  const last = snapshot.last_close || 0;
  if (last < minPrice) rejects.push(`price ₹${fmt(last, 0)} < ₹${fmt(minPrice, 0)}`);

  let turnoverCr: number;
  if (bhav && bhav.turnover_lacs !== null && bhav.turnover_lacs !== undefined) {
    turnoverCr = (bhav.turnover_lacs || 0) / 100.0;
  } else {
    const avgVol = snapshot.volume_avg_20 || 0;
    turnoverCr = (avgVol * last) / 1e7;
  }
  if (turnoverCr < minTurnoverCr) {
    rejects.push(`turnover ₹${fmt(turnoverCr, 1)} Cr < ₹${fmt(minTurnoverCr, 1)} Cr`);
  }

  const tierRank: Record<string, number> = { large: 3, mid: 2, small: 1 };
  const rowTier = universeRow.market_cap_tier || "large";
  if ((tierRank[rowTier] ?? 3) < (tierRank[minMarketCapTier] ?? 1)) {
    rejects.push("below min market-cap tier");
  }

  for (const f of riskFlags || []) {
    rejects.push(`risk flag: ${f}`);
  }
  return { passes: rejects.length === 0, rejects };
}

// ====================================================================
// ATR-based entry / stop / target with minimum 2:1 reward-risk
// ====================================================================
export interface TradeLevels {
  entry_low: number;
  entry_high: number;
  stop_loss: number;
  target_low: number;
  target_high: number;
  risk_reward: number;
  construction?: string;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function entryStopTarget(
  last: number,
  atrIn: number | null,
  direction: "bullish" | "bearish" | string,
  horizon: "weekly" | "monthly" | string,
  minRr = 2.0,
): TradeLevels {
  const atr = atrIn || last * 0.02;

  if (direction === "bullish") {
    const entryLow = round2(last * 0.995);
    const entryHigh = round2(last * 1.01);
    const stop = round2(last - 1.5 * atr);
    const risk = Math.max(0.01, last - stop);
    const tMultLow = horizon === "weekly" ? 2.0 : 3.0;
    const tMultHigh = horizon === "weekly" ? 3.0 : 5.0;
    const tLow = round2(last + Math.max(tMultLow * atr, minRr * risk));
    const tHigh = round2(last + Math.max(tMultHigh * atr, (minRr + 1) * risk));
    return {
      entry_low: entryLow,
      entry_high: entryHigh,
      stop_loss: stop,
      target_low: tLow,
      target_high: tHigh,
      risk_reward: round2((tLow - last) / Math.max(0.01, last - stop)),
    };
  }

  if (direction === "bearish") {
    const entryLow = round2(last * 0.99);
    const entryHigh = round2(last * 1.005);
    const stop = round2(last + 1.5 * atr);
    const risk = Math.max(0.01, stop - last);
    const tMultLow = horizon === "weekly" ? 2.0 : 3.0;
    const tMultHigh = horizon === "weekly" ? 3.0 : 5.0;
    const tLow = round2(last - Math.max(tMultHigh * atr, (minRr + 1) * risk));
    const tHigh = round2(last - Math.max(tMultLow * atr, minRr * risk));
    return {
      entry_low: entryLow,
      entry_high: entryHigh,
      stop_loss: stop,
      target_low: tLow,
      target_high: tHigh,
      risk_reward: round2((last - tHigh) / Math.max(0.01, stop - last)),
    };
  }

  const entryLow = round2(last * 0.99);
  const entryHigh = round2(last * 1.01);
  const stop = round2(last * 0.95);
  const tLow = round2(last * 1.04);
  const tHigh = round2(last * 1.08);
  return {
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stop,
    target_low: tLow,
    target_high: tHigh,
    risk_reward: minRr,
  };
}

export interface LevelBar {
  open?: number;
  close: number;
  high: number;
  low: number;
  volume?: number;
}

function quantile(values: number[], q: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const idx = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * q)));
  return clean[idx];
}

function rewardRisk(entry: number, stop: number, target: number, direction: string): number {
  if (direction === "bearish") {
    return round2((entry - target) / Math.max(0.01, stop - entry));
  }
  return round2((target - entry) / Math.max(0.01, entry - stop));
}

function recentVwap(bars: LevelBar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const v = Number(b.volume || 0);
    if (!v || !b.high || !b.low || !b.close) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * v;
    vol += v;
  }
  return vol ? pv / vol : null;
}

function recentGapZone(bars: LevelBar[], direction: string): { low: number; high: number } | null {
  const recent = bars.slice(-35);
  let best: { low: number; high: number; size: number } | null = null;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (!cur.open || !prev.close) continue;
    const gapPct = ((cur.open - prev.close) / prev.close) * 100;
    if (direction === "bullish" && gapPct > 1.2) {
      const zone = { low: Math.min(prev.close, cur.open), high: Math.max(prev.close, cur.open), size: Math.abs(gapPct) };
      if (!best || zone.size > best.size) best = zone;
    }
    if (direction === "bearish" && gapPct < -1.2) {
      const zone = { low: Math.min(prev.close, cur.open), high: Math.max(prev.close, cur.open), size: Math.abs(gapPct) };
      if (!best || zone.size > best.size) best = zone;
    }
  }
  return best ? { low: best.low, high: best.high } : null;
}

/**
 * Decision-grade construction layer. Uses the existing ATR formula as a
 * baseline, then anchors entries/stops/targets to recent price structure:
 * support/resistance from 20-55 day swing zones and prior highs/lows.
 */
export function structureAwareEntryStopTarget(
  last: number,
  atrIn: number | null,
  direction: "bullish" | "bearish" | string,
  horizon: "weekly" | "monthly" | string,
  bars: LevelBar[] = [],
  minRr = 2.0,
): TradeLevels {
  const fallback = entryStopTarget(last, atrIn, direction, horizon, minRr);
  const recent = bars.slice(-(horizon === "monthly" ? 90 : 45)).filter((b) => b.close && b.high && b.low);
  if (recent.length < 20 || direction === "watch" || direction === "avoid") {
    return { ...fallback, construction: "atr_fallback" };
  }

  const atr = atrIn || last * 0.02;
  const lows20 = recent.slice(-20).map((b) => b.low);
  const highs20 = recent.slice(-20).map((b) => b.high);
  const lows55 = recent.slice(-55).map((b) => b.low);
  const highs55 = recent.slice(-55).map((b) => b.high);
  const support = Math.max(quantile(lows20, 0.2) ?? fallback.entry_low, quantile(lows55, 0.25) ?? fallback.entry_low);
  const resistance = Math.min(quantile(highs20, 0.8) ?? fallback.target_low, quantile(highs55, 0.85) ?? fallback.target_high);
  const vwap = recentVwap(recent.slice(-20));
  const gap = recentGapZone(recent, direction);

  if (direction === "bearish") {
    const entryAnchor = Math.min(
      last * 1.005,
      resistance + 0.15 * atr,
      vwap ? Math.max(last * 0.99, vwap + 0.15 * atr) : last * 1.005,
      gap ? gap.low + 0.25 * (gap.high - gap.low) : last * 1.005,
    );
    const entryHigh = round2(entryAnchor);
    const entryLow = round2(Math.min(entryHigh, Math.max(last * 0.985, entryHigh - 0.75 * atr)));
    const stopBase = Math.max(fallback.stop_loss, resistance + 0.8 * atr, gap ? gap.high + 0.35 * atr : 0);
    const stop = round2(stopBase);
    const rawTarget = Math.min(fallback.target_high, support - 0.25 * atr);
    const targetHigh = round2(Math.min(rawTarget, entryLow - minRr * Math.max(0.01, stop - entryHigh)));
    const targetLow = round2(Math.min(fallback.target_low, targetHigh - atr));
    return {
      entry_low: entryLow,
      entry_high: entryHigh,
      stop_loss: stop,
      target_low: targetLow,
      target_high: targetHigh,
      risk_reward: rewardRisk(entryHigh, stop, targetHigh, direction),
      construction: vwap || gap ? "structure_vwap_gap" : "structure_swing",
    };
  }

  const entryAnchor = Math.max(
    last * 0.985,
    support - 0.15 * atr,
    vwap ? Math.min(last * 1.005, vwap - 0.15 * atr) : last * 0.985,
    gap ? gap.high - 0.25 * (gap.high - gap.low) : last * 0.985,
  );
  const entryLow = round2(entryAnchor);
  const entryHigh = round2(Math.max(entryLow, Math.min(last * 1.005, entryLow + 0.75 * atr)));
  const stopBase = Math.min(fallback.stop_loss, support - 0.8 * atr, gap ? gap.low - 0.35 * atr : Number.POSITIVE_INFINITY);
  const stop = round2(stopBase);
  const rawTarget = Math.max(fallback.target_low, resistance + 0.25 * atr);
  const targetLow = round2(Math.max(rawTarget, entryHigh + minRr * Math.max(0.01, entryHigh - stop)));
  const targetHigh = round2(Math.max(fallback.target_high, targetLow + atr));
  return {
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stop,
    target_low: targetLow,
    target_high: targetHigh,
    risk_reward: rewardRisk(entryHigh, stop, targetLow, direction),
    construction: vwap || gap ? "structure_vwap_gap" : "structure_swing",
  };
}
