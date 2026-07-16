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

async function selectAll<T>(table: string, columns: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await db.from(table).select(columns).range(from, to);
    if (error) throw new Error(`Failed to load ${table}: ${error.message}`);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

function isScreenableNseEquity(symbol: string, name: string | null | undefined): boolean {
  if (!symbol) return false;
  if (/^\d/.test(symbol)) return false;

  // Keep ordinary listed equities. Exclude ETFs, REITs/InvITs, debt/gilt
  // products, rights/temporary series and SME/surveillance suffixes that
  // Yahoo often cannot resolve as .NS equities.
  const upperName = (name || "").toUpperCase();
  const blockedNameTokens = [
    " ETF",
    "ETF ",
    "BEES",
    "LIQUID",
    "GILT",
    "SDL",
    "TBILL",
    "TREASURY",
    "INVIT",
    "REIT",
    "BOND",
    "NCD",
    "DEBENTURE",
  ];
  if (blockedNameTokens.some((token) => upperName.includes(token))) return false;

  const blockedSuffixes = ["-BE", "-BZ", "-SM", "-ST", "-RR", "-IV", "-GB", "-GS", "-SG", "-N0", "-N1", "-N2", "-N3"];
  if (blockedSuffixes.some((suffix) => symbol.endsWith(suffix))) return false;

  return true;
}

/** Load the current universe (id-free rows the pipeline consumes). */
export async function loadUniverse(limit = 5000): Promise<UniverseRow[]> {
  const rows = await selectAll<UniverseRow>("stock_universe", "symbol, yf_symbol, name, sector, industry, market_cap_tier");
  return rows.slice(0, limit);
}

/**
 * Insert any NSE EQ instrument from kite_instruments that isn't already in
 * stock_universe. Curated rows are never overwritten (insert-if-missing),
 * so hand-tagged sectors win. Returns {inserted, total}. If the instrument
 * cache is empty (never refreshed), this is a no-op and the pipeline runs
 * on whatever is already seeded (the curated 51).
 */
export async function expandUniverseFromKite(): Promise<{ inserted: number; total: number }> {
  const allInstruments = await selectAll<{
    tradingsymbol: string;
    name: string | null;
    exchange: string | null;
    instrument_type: string | null;
  }>(
    "kite_instruments",
    "tradingsymbol, name, exchange, instrument_type",
  );
  const instruments = allInstruments.filter((inst) => {
    const symbol = (inst.tradingsymbol || "").toUpperCase();
    return inst.exchange === "NSE" && inst.instrument_type === "EQ" && isScreenableNseEquity(symbol, inst.name);
  });

  const existing = await selectAll<{ symbol: string }>("stock_universe", "symbol");
  const known = new Set((existing || []).map((r) => r.symbol));

  const toInsert: UniverseRow[] = [];
  for (const inst of instruments) {
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
