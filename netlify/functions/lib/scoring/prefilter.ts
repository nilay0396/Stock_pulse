/**
 * Stage 1 funnel — full-universe lightweight prefilter.
 * Ported 1:1 from backend/services/prefilter.py.
 *
 * Stage 1: scan the full NSE EQ-series universe using only cheap sources
 * (bhavcopy -> OHLC), compute lightweight technicals, shortlist the top
 * candidates. No LLM, no per-stock HTTP calls — scales linearly with
 * universe size. Consumed by the Phase 4 pipeline; not wired to any route
 * in Phase 2.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

export const PREFILTER_MIN_PRICE = 50.0;
export const PREFILTER_MIN_TURNOVER_CR = 1.0;
export const PREFILTER_MIN_DELIV_PCT = 20.0;

export function prefilterByBhavcopy(
  universe: Dict[],
  bhavMap: Record<string, Dict>,
  minPrice = PREFILTER_MIN_PRICE,
  minTurnoverCr = PREFILTER_MIN_TURNOVER_CR,
  minDelivPct = PREFILTER_MIN_DELIV_PCT,
): Dict[] {
  const out: Dict[] = [];
  for (const u of universe) {
    const sym = (u.symbol || "").toUpperCase();
    const b = bhavMap[sym];
    if (!b) continue;
    const close = b.close || 0.0;
    if (close < minPrice) continue;
    const turnoverCr = (b.turnover_lacs || 0.0) / 100.0;
    if (turnoverCr < minTurnoverCr) continue;
    const deliv = b.deliv_pct;
    // Allow stocks where deliv_pct is missing — some series don't report it.
    if (deliv !== null && deliv !== undefined && deliv < minDelivPct) continue;
    out.push({ ...u, _bhav_close: close, _bhav_turnover_cr: turnoverCr, _bhav_deliv_pct: deliv });
  }
  return out;
}

export function lightweightSetupScore(snap: Dict): [number, string[]] {
  const last = snap.last_close || 0.0;
  const sma50 = snap.sma_50 || 0.0;
  const sma200 = snap.sma_200 || 0.0;
  const rsiV = snap.rsi_14;
  const mom1m = snap.change_pct_1m || 0.0;
  const spike = snap.volume_spike || 1.0;
  const rel = snap.relative_strength || 0.0;
  const atrV = snap.atr_14 || 0.0;

  const reasons: string[] = [];

  // 1) Trend: 0/33/66/100
  let trendScore = 0.0;
  if (sma50 && last > sma50) trendScore += 33;
  if (sma200 && last > sma200) trendScore += 33;
  if (sma50 && sma200 && sma50 > sma200) trendScore += 34;
  if (trendScore >= 66) reasons.push("Above SMA-50/200");

  // 2) RSI
  let rsiScore = 50.0;
  if (rsiV !== null && rsiV !== undefined) {
    if (rsiV >= 50 && rsiV <= 65) {
      rsiScore = 100;
      reasons.push(`RSI sweet (${rsiV.toFixed(0)})`);
    } else if ((rsiV >= 40 && rsiV < 50) || (rsiV > 65 && rsiV <= 72)) {
      rsiScore = 75;
    } else if (rsiV < 30 || rsiV > 78) {
      rsiScore = 20;
    } else {
      rsiScore = 55;
    }
  }

  // 3) Momentum 1m
  const momScore = Math.max(0.0, Math.min(100.0, 50 + mom1m * 2.5));
  if (mom1m >= 5) reasons.push(`+${mom1m.toFixed(1)}% 1m`);

  // 4) Volume spike
  let volScore: number;
  if (spike >= 1.3 && spike <= 3.0) {
    volScore = 100.0;
    reasons.push(`Vol ${spike.toFixed(1)}x avg`);
  } else if (spike >= 1.0) {
    volScore = 70.0;
  } else if (spike >= 0.7) {
    volScore = 50.0;
  } else {
    volScore = 25.0;
  }

  // 5) Relative strength vs NIFTY (in %)
  const rsScore = Math.max(0.0, Math.min(100.0, 50 + rel * 5));
  if (rel > 5) reasons.push(`RS +${rel.toFixed(1)}% vs NIFTY`);

  // 6) ATR / price ratio
  let atrScore = 50.0;
  if (atrV && last) {
    const ratio = (atrV / last) * 100;
    if (ratio >= 1.0 && ratio <= 4.0) atrScore = 100.0;
    else if (ratio < 1.0 || ratio > 6.0) atrScore = 25.0;
    else atrScore = 60.0;
  }

  const composite = (trendScore + rsiScore + momScore + volScore + rsScore + atrScore) / 6;
  return [Math.round(composite * 100) / 100, reasons.slice(0, 3)];
}

export interface PrefilterRow {
  symbol: string;
  sector: string;
  name: string;
  last_close: number | null;
  rsi_14: number | null;
  change_pct_1m: number | null;
  volume_spike: number | null;
  relative_strength: number | null;
  setup: string | null;
  lite_score: number;
  lite_reasons: string[];
}

export function rankAndShortlist(
  snapshots: Dict[],
  universeBySym: Record<string, Dict>,
  topN = 200,
  minSetupScore = 50.0,
): [Dict[], PrefilterRow[]] {
  const rows: PrefilterRow[] = snapshots.map((snap) => {
    const [score, reasons] = lightweightSetupScore(snap);
    return {
      symbol: snap.symbol,
      sector: snap.sector || "Other",
      name: snap.name || snap.symbol,
      last_close: snap.last_close ?? null,
      rsi_14: snap.rsi_14 ?? null,
      change_pct_1m: snap.change_pct_1m ?? null,
      volume_spike: snap.volume_spike ?? null,
      relative_strength: snap.relative_strength ?? null,
      setup: snap.setup ?? null,
      lite_score: score,
      lite_reasons: reasons,
    };
  });
  rows.sort((a, b) => b.lite_score - a.lite_score);

  const qualified = rows.filter((r) => r.lite_score >= minSetupScore);
  const shortlistedSyms = qualified.slice(0, topN).map((r) => r.symbol);
  const shortlisted = shortlistedSyms
    .filter((s) => s in universeBySym)
    .map((s) => universeBySym[s]);
  return [shortlisted, rows];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
