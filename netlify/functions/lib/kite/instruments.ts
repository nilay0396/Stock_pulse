import type { Connect } from "kiteconnect";
import { db } from "../db.js";

export type KiteInstrumentExchange = "NSE" | "NFO";

export interface InstrumentRefreshOptions {
  exchange?: KiteInstrumentExchange;
  offset?: number;
  limit?: number;
}

export interface InstrumentRefreshResult {
  exchange: KiteInstrumentExchange;
  total_filtered: number;
  offset: number;
  limit: number | null;
  upserted: number;
  has_more: boolean;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

function rowForInstrument(inst: any, refreshedAt: string): Record<string, unknown> | null {
  if (inst.exchange === "NSE") {
    if (inst.instrument_type !== "EQ") return null;
    return {
      instrument_token: Number(inst.instrument_token),
      tradingsymbol: inst.tradingsymbol,
      name: inst.name || null,
      expiry: null,
      strike: null,
      instrument_type: "EQ",
      segment: inst.segment,
      exchange: inst.exchange,
      refreshed_at: refreshedAt,
    };
  }

  if (inst.exchange === "NFO") {
    if (inst.instrument_type !== "CE" && inst.instrument_type !== "PE") return null;
    return {
      instrument_token: Number(inst.instrument_token),
      tradingsymbol: inst.tradingsymbol,
      name: inst.name || null,
      expiry: inst.expiry ? toDateOnly(new Date(inst.expiry)) : null,
      strike: inst.strike || null,
      instrument_type: inst.instrument_type,
      segment: inst.segment,
      exchange: inst.exchange,
      refreshed_at: refreshedAt,
    };
  }

  return null;
}

async function upsertRows(rows: Record<string, unknown>[]): Promise<void> {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await db.from("kite_instruments").upsert(chunk, { onConflict: "instrument_token" });
    if (error) {
      throw new Error(`Instrument cache upsert failed at offset ${i}: ${error.message}`);
    }
  }
}

export async function refreshKiteInstrumentSlice(
  kc: Connect,
  options: InstrumentRefreshOptions = {},
): Promise<InstrumentRefreshResult> {
  const exchange = options.exchange || "NSE";
  const offset = normalizePositiveInt(options.offset, 0);
  const limit = options.limit === undefined ? null : Math.max(1, Math.floor(options.limit));
  const refreshedAt = new Date().toISOString();

  const instruments = await kc.getInstruments(exchange);
  const rows = instruments
    .map((inst) => rowForInstrument(inst, refreshedAt))
    .filter((row): row is Record<string, unknown> => row !== null);

  const slice = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
  await upsertRows(slice);

  return {
    exchange,
    total_filtered: rows.length,
    offset,
    limit,
    upserted: slice.length,
    has_more: limit !== null && offset + limit < rows.length,
  };
}
