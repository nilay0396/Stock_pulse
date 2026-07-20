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
 * Kite quote data does not directly provide IV. We estimate IV from LTP using
 * Black-Scholes when spot/strike/expiry are available, and persist OI
 * snapshots so later runs can calculate change-in-OI.
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

async function previousOi(
  symbol: string,
  expiry: string,
  strike: number,
  side: "CE" | "PE",
): Promise<number | null> {
  const { data } = await db
    .from("fno_oi_snapshots")
    .select("oi")
    .eq("symbol", symbol.toUpperCase())
    .eq("expiry", expiry)
    .eq("strike", strike)
    .eq("side", side)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.oi === null || data?.oi === undefined ? null : Number(data.oi);
}

async function persistOiSnapshots(chain: OptionChain): Promise<void> {
  if (!chain.eligible || !chain.expiries.length) return;
  const expiry = chain.expiries[0];
  const rows = [...chain.calls, ...chain.puts].map((c) => ({
    symbol: chain.symbol,
    expiry,
    strike: c.strike,
    side: c.side,
    oi: c.oi,
    change_oi: c.change_oi,
    ltp: c.ltp,
    volume: c.volume,
    iv: c.iv,
    underlying: chain.underlying,
    source: chain.source,
    fetched_at: chain.fetched_at,
  }));
  if (!rows.length) return;
  const { error } = await db.from("fno_oi_snapshots").insert(rows);
  if (error) console.warn("fno_oi_snapshots insert warning:", error.message);
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function blackScholes(
  side: "CE" | "PE",
  spot: number,
  strike: number,
  years: number,
  vol: number,
  rate = 0.065,
): number {
  if (spot <= 0 || strike <= 0 || years <= 0 || vol <= 0) return 0;
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  if (side === "CE") return spot * normCdf(d1) - strike * Math.exp(-rate * years) * normCdf(d2);
  return strike * Math.exp(-rate * years) * normCdf(-d2) - spot * normCdf(-d1);
}

function impliedVolPct(
  side: "CE" | "PE",
  ltp: number | null,
  spot: number | null,
  strike: number,
  expiry: string,
): number | null {
  if (!ltp || !spot || !strike) return null;
  const years = Math.max(1 / 365, (new Date(`${expiry}T15:30:00+05:30`).getTime() - Date.now()) / (365 * 86400000));
  const intrinsic = side === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (ltp <= intrinsic) return null;

  let lo = 0.01;
  let hi = 5.0;
  for (let i = 0; i < 70; i += 1) {
    const mid = (lo + hi) / 2;
    const price = blackScholes(side, spot, strike, years, mid);
    if (price > ltp) hi = mid;
    else lo = mid;
  }
  const iv = ((lo + hi) / 2) * 100;
  return Number.isFinite(iv) && iv > 0 && iv < 500 ? Math.round(iv * 100) / 100 : null;
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

    const calls: NormalizedContract[] = [];
    const puts: NormalizedContract[] = [];
    for (const c of contracts) {
      const q = quotes[`${c.exchange}:${c.tradingsymbol}`];
      const oi = q?.oi ?? null;
      const ltp = q?.last_price ?? null;
      const prevOi = oi === null ? null : await previousOi(underlying, expiry, c.strike, c.instrument_type);
      const contract: NormalizedContract = {
        strike: c.strike,
        expiry,
        oi,
        change_oi: oi === null || prevOi === null ? null : oi - prevOi,
        ltp,
        volume: q?.volume ?? null,
        iv: impliedVolPct(c.instrument_type, ltp, underlyingPrice, c.strike, expiry),
        side: c.instrument_type,
      };
      (c.instrument_type === "CE" ? calls : puts).push(contract);
    }

    const chain = {
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
    await persistOiSnapshots(chain);
    return chain;
  } catch (err) {
    return emptyChain(underlying, fetchedAt, err instanceof Error ? err.message : String(err));
  }
}
