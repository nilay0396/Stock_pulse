import type { Connect } from "kiteconnect";
import { db } from "../db.js";
import type { OhlcvBar } from "../scoring/indicators.js";
import type { DatedOhlcvBar } from "../market/yahoo.js";

/** Kite's Historical Candle API is one instrument per call (no batch
 * download like yfinance) — this is only meant for the Stage-2 shortlist
 * (~200 symbols), never the full ~2,000-stock universe. Paced well under
 * Kite's historical-API rate limit (~3 req/sec); 200 symbols at this pace
 * takes roughly a minute. */
const REQUEST_PACING_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function lookupInstrumentToken(tradingsymbol: string): Promise<number | null> {
  const { data, error } = await db
    .from("kite_instruments")
    .select("instrument_token")
    .eq("tradingsymbol", tradingsymbol.toUpperCase())
    .eq("exchange", "NSE")
    .eq("instrument_type", "EQ")
    .maybeSingle();
  if (error || !data) return null;
  return data.instrument_token;
}

/** Fetch ~1y of daily candles for one symbol, mapped to the OhlcvBar shape
 * computeSnapshot() expects. Returns null if the symbol isn't in the
 * cached instrument master or the API call fails (fault-isolated —
 * matches the Python connectors' per-symbol failure pattern). */
export async function fetchHistoricalBars(
  kc: Connect,
  tradingsymbol: string,
  lookbackDays = 370,
): Promise<OhlcvBar[] | null> {
  try {
    const instrumentToken = await lookupInstrumentToken(tradingsymbol);
    if (instrumentToken === null) {
      console.warn(`kite-historical: no instrument_token cached for ${tradingsymbol}`);
      return null;
    }

    const to = new Date();
    const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const candles = await kc.getHistoricalData(instrumentToken, "day", toDateOnly(from), toDateOnly(to));

    return candles.map((c) => ({
      close: c.close,
      high: c.high,
      low: c.low,
      volume: c.volume,
    }));
  } catch (err) {
    console.warn(`kite-historical: failed for ${tradingsymbol}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function fetchHistoricalBarsDated(
  kc: Connect,
  tradingsymbol: string,
  lookbackDays = 370,
  interval: "day" | "minute" | "3minute" | "5minute" | "10minute" | "15minute" | "30minute" | "60minute" = "day",
): Promise<DatedOhlcvBar[] | null> {
  try {
    const instrumentToken = await lookupInstrumentToken(tradingsymbol);
    if (instrumentToken === null) {
      console.warn(`kite-historical: no instrument_token cached for ${tradingsymbol}`);
      return null;
    }

    const to = new Date();
    const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const candles = await kc.getHistoricalData(instrumentToken, interval, toDateOnly(from), toDateOnly(to));

    return candles.map((c) => ({
      date: c.date instanceof Date ? c.date.toISOString().slice(0, 10) : String(c.date).slice(0, 10),
      open: c.open,
      close: c.close,
      high: c.high,
      low: c.low,
      volume: c.volume,
    }));
  } catch (err) {
    console.warn(`kite-historical: failed for ${tradingsymbol}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Sequential, rate-limit-paced fetch for the Stage-2 shortlist. Each
 * symbol's failure is isolated — one bad symbol doesn't abort the batch. */
export async function fetchHistoricalBarsForSymbols(
  kc: Connect,
  tradingsymbols: string[],
): Promise<Record<string, OhlcvBar[]>> {
  const out: Record<string, OhlcvBar[]> = {};
  for (const symbol of tradingsymbols) {
    const bars = await fetchHistoricalBars(kc, symbol);
    if (bars) out[symbol] = bars;
    await sleep(REQUEST_PACING_MS);
  }
  return out;
}
