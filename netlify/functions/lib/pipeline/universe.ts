/**
 * Universe expansion — Kite-sourced replacement for the Python
 * seed_full_nse_universe (which hit NSE's Akamai-blocked EQUITY_L CSV).
 * Populates stock_universe from the cloud-safe kite_instruments cache
 * (NSE EQ names), preserving the hand-curated sector tags on the 51
 * seeded large-caps. New names land with sector='Other' until enriched.
 */
import { db } from "../db.js";

export interface UniverseRow {
  symbol: string;
  yf_symbol: string;
  name: string;
  sector: string;
  industry: string;
  market_cap_tier: string;
}

/** Load the current universe (id-free rows the pipeline consumes). */
export async function loadUniverse(limit = 5000): Promise<UniverseRow[]> {
  const { data, error } = await db
    .from("stock_universe")
    .select("symbol, yf_symbol, name, sector, industry, market_cap_tier")
    .limit(limit);
  if (error) throw new Error(`Failed to load universe: ${error.message}`);
  return (data || []) as UniverseRow[];
}

/**
 * Insert any NSE EQ instrument from kite_instruments that isn't already in
 * stock_universe. Curated rows are never overwritten (insert-if-missing),
 * so hand-tagged sectors win. Returns {inserted, total}. If the instrument
 * cache is empty (never refreshed), this is a no-op and the pipeline runs
 * on whatever is already seeded (the curated 51).
 */
export async function expandUniverseFromKite(): Promise<{ inserted: number; total: number }> {
  const { data: instruments, error } = await db
    .from("kite_instruments")
    .select("tradingsymbol, name")
    .eq("exchange", "NSE")
    .eq("instrument_type", "EQ");
  if (error) throw new Error(`Failed to read kite_instruments: ${error.message}`);

  const { data: existing } = await db.from("stock_universe").select("symbol");
  const known = new Set((existing || []).map((r) => r.symbol));

  const toInsert: UniverseRow[] = [];
  for (const inst of instruments || []) {
    const symbol = (inst.tradingsymbol || "").toUpperCase();
    if (!symbol || known.has(symbol)) continue;
    known.add(symbol);
    toInsert.push({
      symbol,
      // yahoo-finance2 URL-encodes internally, so store the raw symbol form.
      yf_symbol: `${symbol}.NS`,
      name: inst.name || symbol,
      sector: "Other",
      industry: "Unknown",
      market_cap_tier: "unknown",
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error: insErr } = await db.from("stock_universe").upsert(chunk, { onConflict: "symbol", ignoreDuplicates: true });
    if (insErr) throw new Error(`Universe insert failed at ${i}: ${insErr.message}`);
  }

  const { count } = await db.from("stock_universe").select("*", { count: "exact", head: true });
  return { inserted: toInsert.length, total: count ?? 0 };
}
