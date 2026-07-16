import type { Connect } from "kiteconnect";
import { db } from "../db.js";

/**
 * Kite has no single "option chain" endpoint (unlike NSE's website) — this
 * assembles one from the cached instrument master (filtered by underlying
 * name + type + nearest expiry) plus a single batched /quote call for
 * OI/LTP/volume. This is a genuinely new capability: the Python original's
 * F&O module was stubbed out entirely (NSE-direct blocked by Akamai WAF;
 * Upstox/Fyers integrations never implemented).
 *
 * Two fields Kite's quote API does not provide, left null rather than
 * fabricated: `change_oi` (no prior-day OI baseline in the basic quote
 * response) and `iv` (would need a Black-Scholes back-out from LTP, out of
 * scope for a data connector).
 */

export interface NormalizedContract {
  strike: number;
  expiry: string;
  oi: number | null;
  change_oi: number | null;
  ltp: number | null;
  volume: number | null;
  iv: number | null;
  side: "CE" | "PE";
}

export interface OptionChain {
  symbol: string;
  eligible: boolean;
  source: string;
  fetched_at: string;
  underlying: number | null;
  expiries: string[];
  calls: NormalizedContract[];
  puts: NormalizedContract[];
  error: string | null;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function findNearestExpiry(underlying: string): Promise<string | null> {
  const today = toDateOnly(new Date());
  const { data, error } = await db
    .from("kite_instruments")
    .select("expiry")
    .eq("name", underlying.toUpperCase())
    .in("instrument_type", ["CE", "PE"])
    .gte("expiry", today)
    .order("expiry", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.expiry as string;
}

interface CachedContract {
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  exchange: string;
}

async function getContractsForExpiry(underlying: string, expiry: string): Promise<CachedContract[]> {
  const { data, error } = await db
    .from("kite_instruments")
    .select("tradingsymbol, strike, instrument_type, exchange")
    .eq("name", underlying.toUpperCase())
    .in("instrument_type", ["CE", "PE"])
    .eq("expiry", expiry);
  if (error) throw new Error(`Failed to load contracts for ${underlying} ${expiry}: ${error.message}`);
  return (data || []) as CachedContract[];
}

function emptyChain(underlying: string, fetchedAt: string, error: string): OptionChain {
  return {
    symbol: underlying.toUpperCase(),
    eligible: false,
    source: "kite",
    fetched_at: fetchedAt,
    underlying: null,
    expiries: [],
    calls: [],
    puts: [],
    error,
  };
}

export async function fetchOptionChain(kc: Connect, underlying: string): Promise<OptionChain> {
  const fetchedAt = new Date().toISOString();
  try {
    const expiry = await findNearestExpiry(underlying);
    if (!expiry) {
      return emptyChain(underlying, fetchedAt, "not F&O eligible, or instrument cache not refreshed yet");
    }

    const contracts = await getContractsForExpiry(underlying, expiry);
    if (contracts.length === 0) {
      return emptyChain(underlying, fetchedAt, "no contracts found for nearest expiry");
    }

    // Batched quote call — a single expiry's chain (calls + puts) is well
    // under Kite's 500-instrument-per-call limit for /quote.
    const instrumentKeys = contracts.map((c) => `${c.exchange}:${c.tradingsymbol}`);
    const quotes = await kc.getQuote(instrumentKeys);

    const calls: NormalizedContract[] = [];
    const puts: NormalizedContract[] = [];
    for (const c of contracts) {
      const q = quotes[`${c.exchange}:${c.tradingsymbol}`];
      const contract: NormalizedContract = {
        strike: c.strike,
        expiry,
        oi: q?.oi ?? null,
        change_oi: null,
        ltp: q?.last_price ?? null,
        volume: q?.volume ?? null,
        iv: null,
        side: c.instrument_type,
      };
      (c.instrument_type === "CE" ? calls : puts).push(contract);
    }

    // Spot price for the underlying, best-effort (index underlyings like
    // NIFTY aren't NSE:EQ tradingsymbols, so this can legitimately fail).
    let underlyingPrice: number | null = null;
    try {
      const spotKey = `NSE:${underlying.toUpperCase()}`;
      const spotQuote = await kc.getQuote([spotKey]);
      underlyingPrice = spotQuote[spotKey]?.last_price ?? null;
    } catch {
      underlyingPrice = null;
    }

    return {
      symbol: underlying.toUpperCase(),
      eligible: true,
      source: "kite",
      fetched_at: fetchedAt,
      underlying: underlyingPrice,
      expiries: [expiry],
      calls,
      puts,
      error: null,
    };
  } catch (err) {
    return emptyChain(underlying, fetchedAt, err instanceof Error ? err.message : String(err));
  }
}
