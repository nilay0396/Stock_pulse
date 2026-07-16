/**
 * Pure technical-indicator library. Ported 1:1 from backend/services/indicators.py.
 *
 * IMPORTANT — numeric parity notes (do not "fix" these, they're intentional
 * fidelity to the Python system this is meant to match):
 * - RSI and ATR use SIMPLE rolling means, not Wilder smoothing.
 * - Bollinger/volatility use SAMPLE stddev (ddof=1), matching pandas' default.
 * - EMA uses the `.ewm(span, adjust=False)` recursive form.
 * - True Range at the first bar uses only |H-L| (skips the two legs that
 *   need a previous close), matching pandas' `.max(axis=1, skipna=True)`
 *   default rather than propagating null.
 * - Several fields below use a "falsy → null" check (`x ? round(x) : null`)
 *   rather than a strict null check, exactly mirroring the Python
 *   `if x else None` pattern — this means a genuine value of 0 also maps to
 *   null for those fields (sma/ema/bollinger/atr), same as upstream. RSI and
 *   MACD fields use a strict null check instead, also matching upstream.
 * - `relativeStrength`'s benchmark lookback index (`-22`) is intentionally
 *   one bar off from `pctChange(22)`'s own lookback (`-23`) — this
 *   inconsistency exists in the Python source and is preserved here.
 */

export type Series = (number | null)[];

export interface OhlcvBar {
  close: number;
  high: number;
  low: number;
  volume?: number;
}

export interface TechnicalSnapshot {
  last_close: number;
  change_pct_1d: number;
  change_pct_1w: number;
  change_pct_1m: number;
  rsi_14: number | null;
  sma_20: number | null;
  sma_50: number | null;
  sma_100: number | null;
  sma_200: number | null;
  ema_20: number | null;
  ema_50: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_mid: number | null;
  atr_14: number | null;
  volatility_20: number;
  volume_spike: number;
  volume_avg_20: number;
  relative_strength: number;
  setup: "breakout" | "pullback" | "range" | "downtrend" | "neutral";
}

function pyRound(x: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((x + Number.EPSILON) * factor) / factor;
}

/** pandas Series.diff() — index 0 is always null (no previous value). */
function diff(values: Series): Series {
  const out: Series = [null];
  for (let i = 1; i < values.length; i++) {
    const cur = values[i];
    const prev = values[i - 1];
    out.push(cur === null || prev === null ? null : cur - prev);
  }
  return out;
}

function clipLower(values: Series, lower: number): Series {
  return values.map((v) => (v === null ? null : Math.max(v, lower)));
}

function clipUpper(values: Series, upper: number): Series {
  return values.map((v) => (v === null ? null : Math.min(v, upper)));
}

/** pandas .rolling(period).mean() with default min_periods=period: any null
 * in the window (or insufficient length) makes the result null. */
function rollingMean(values: Series, period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let poisoned = false;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        poisoned = true;
        break;
      }
      sum += v;
    }
    out[i] = poisoned ? null : sum / period;
  }
  return out;
}

/** pandas .rolling(period).std() — sample stddev, ddof=1. Same null-window
 * semantics as rollingMean. */
function rollingStd(values: Series, period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window: number[] = [];
    let poisoned = false;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        poisoned = true;
        break;
      }
      window.push(v);
    }
    if (poisoned) continue;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1);
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/** pandas .ewm(span, adjust=False).mean(). Assumes no internal nulls in
 * `values` after the first element (true for close-price series here). */
function ewm(values: Series, span: number): Series {
  const alpha = 2 / (span + 1);
  const out: Series = new Array(values.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      out[i] = prev;
      continue;
    }
    prev = prev === null ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(close: Series, period = 14): Series {
  const delta = diff(close);
  const gain = rollingMean(clipLower(delta, 0), period);
  const loss = rollingMean(clipUpper(delta, 0).map((v) => (v === null ? null : -v)), period);
  return gain.map((g, i) => {
    const l = loss[i];
    if (g === null || l === null || l === 0) return null;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  });
}

export function sma(series: Series, period: number): Series {
  return rollingMean(series, period);
}

export function ema(series: Series, period: number): Series {
  return ewm(series, period);
}

export function macd(
  close: Series,
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: Series; signal: Series; hist: Series } {
  const fastE = ema(close, fast);
  const slowE = ema(close, slow);
  const line: Series = fastE.map((f, i) => {
    const s = slowE[i];
    return f === null || s === null ? null : f - s;
  });
  const sig = ema(line, signal);
  const hist: Series = line.map((l, i) => {
    const s = sig[i];
    return l === null || s === null ? null : l - s;
  });
  return { macd: line, signal: sig, hist };
}

export function bollinger(
  series: Series,
  period = 20,
  numStd = 2.0,
): { upper: Series; lower: Series; mid: Series } {
  const mid = sma(series, period);
  const std = rollingStd(series, period);
  const upper: Series = mid.map((m, i) => {
    const s = std[i];
    return m === null || s === null ? null : m + numStd * s;
  });
  const lower: Series = mid.map((m, i) => {
    const s = std[i];
    return m === null || s === null ? null : m - numStd * s;
  });
  return { upper, lower, mid };
}

export function atr(high: Series, low: Series, close: Series, period = 14): Series {
  const prevClose: Series = [null, ...close.slice(0, -1)];
  const tr: Series = high.map((h, i) => {
    const l = low[i];
    const pc = prevClose[i];
    if (h === null || l === null) return null;
    const legs: number[] = [Math.abs(h - l)];
    if (pc !== null) {
      legs.push(Math.abs(h - pc), Math.abs(l - pc));
    }
    // pandas .max(axis=1) defaults to skipna=True — a missing prevClose leg
    // (only at index 0) doesn't poison the row, it just isn't a candidate.
    return Math.max(...legs);
  });
  return rollingMean(tr, period);
}

function last(series: Series): number | null {
  if (series.length === 0) return null;
  const v = series[series.length - 1];
  return v === null || Number.isNaN(v) ? null : v;
}

export function computeSnapshot(
  bars: OhlcvBar[],
  benchmarkClose?: Series,
): Partial<TechnicalSnapshot> {
  if (!bars || bars.length === 0) return {};

  const close: Series = bars.map((b) => b.close);
  const high: Series = bars.map((b) => b.high);
  const low: Series = bars.map((b) => b.low);
  const volume: Series = bars.map((b) => (b.volume === undefined ? null : b.volume));

  if (close.length < 30) return {};

  const macdVals = macd(close);
  const bb = bollinger(close);
  const atrV = atr(high, low, close);
  const rsiV = rsi(close);

  const lastClose = close[close.length - 1] as number;

  function pctChange(periods: number): number {
    if (close.length <= periods) return 0;
    const prev = close[close.length - 1 - periods];
    if (prev === null || prev === 0) return 0;
    return ((lastClose - prev) / prev) * 100;
  }

  const sma20 = last(sma(close, 20));
  const sma50 = last(sma(close, 50));
  const sma100 = last(sma(close, 100));
  const sma200 = last(sma(close, 200));

  const validVolume = volume.filter((v): v is number => v !== null);
  const volTail20 = validVolume.slice(-20);
  const volAvg20 = validVolume.length > 0 ? volTail20.reduce((a, b) => a + b, 0) / volTail20.length : 0;
  const volLast = validVolume.length > 0 ? validVolume[validVolume.length - 1] : 0;
  const volSpike = volAvg20 > 0 ? volLast / volAvg20 : 1.0;

  // Volatility: std of daily returns * sqrt(252) * 100 (sample stddev, ddof=1)
  const returns: number[] = [];
  for (let i = 1; i < close.length; i++) {
    const cur = close[i];
    const prev = close[i - 1];
    if (cur === null || prev === null || prev === 0) continue;
    returns.push((cur - prev) / prev);
  }
  let vol20 = 0;
  if (returns.length > 20) {
    const tail = returns.slice(-20);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const variance = tail.reduce((a, b) => a + (b - mean) ** 2, 0) / (tail.length - 1);
    vol20 = Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  // Relative strength vs benchmark. NOTE: benchmark lookback index (-22) is
  // intentionally NOT the same offset as pctChange(22)'s own (-23) — see
  // file header.
  let rel = 0;
  if (benchmarkClose && benchmarkClose.length > 22) {
    const bmLast = benchmarkClose[benchmarkClose.length - 1];
    const bmPrev = benchmarkClose[benchmarkClose.length - 22];
    if (bmLast !== null && bmPrev !== null) {
      const bmPct = bmPrev ? ((bmLast - bmPrev) / bmPrev) * 100 : 0;
      rel = pctChange(22) - bmPct;
    }
  }

  // Setup classification
  let setup: TechnicalSnapshot["setup"];
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  if (bbUpper && lastClose >= bbUpper * 0.995) {
    setup = "breakout";
  } else if (bbLower && lastClose <= bbLower * 1.005) {
    setup = sma50 && lastClose >= sma50 ? "pullback" : "downtrend";
  } else if (sma20 && sma50 && sma20 > sma50 && lastClose > sma20) {
    setup = lastClose < sma20 * 1.02 ? "pullback" : "breakout";
  } else if (sma20 && sma50 && sma20 < sma50) {
    setup = "downtrend";
  } else {
    setup = "range";
  }

  const ema20 = last(ema(close, 20));
  const ema50 = last(ema(close, 50));
  const macdLast = last(macdVals.macd);
  const macdSignalLast = last(macdVals.signal);
  const macdHistLast = last(macdVals.hist);
  const atrLast = last(atrV);
  const bbMid = last(bb.mid);
  const rsiLast = last(rsiV);

  return {
    last_close: pyRound(lastClose, 4),
    change_pct_1d: pyRound(pctChange(1), 3),
    change_pct_1w: pyRound(pctChange(5), 3),
    change_pct_1m: pyRound(pctChange(22), 3),
    rsi_14: rsiLast !== null ? pyRound(rsiLast, 2) : null,
    sma_20: sma20 ? pyRound(sma20, 4) : null,
    sma_50: sma50 ? pyRound(sma50, 4) : null,
    sma_100: sma100 ? pyRound(sma100, 4) : null,
    sma_200: sma200 ? pyRound(sma200, 4) : null,
    ema_20: ema20 ? pyRound(ema20, 4) : null,
    ema_50: ema50 ? pyRound(ema50, 4) : null,
    macd: macdLast !== null ? pyRound(macdLast, 4) : null,
    macd_signal: macdSignalLast !== null ? pyRound(macdSignalLast, 4) : null,
    macd_hist: macdHistLast !== null ? pyRound(macdHistLast, 4) : null,
    bb_upper: bbUpper ? pyRound(bbUpper, 4) : null,
    bb_lower: bbLower ? pyRound(bbLower, 4) : null,
    bb_mid: bbMid ? pyRound(bbMid, 4) : null,
    atr_14: atrLast ? pyRound(atrLast, 4) : null,
    volatility_20: pyRound(vol20, 3),
    volume_spike: pyRound(volSpike, 3),
    volume_avg_20: pyRound(volAvg20, 0),
    relative_strength: pyRound(rel, 3),
    setup,
  };
}
