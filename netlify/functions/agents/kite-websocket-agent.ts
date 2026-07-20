import { KiteTicker, type Tick } from "kiteconnect";
import { db } from "../lib/db.js";

type InstrumentRow = {
  tradingsymbol: string;
  instrument_token: number;
  exchange: string;
};

const DEFAULT_MANUAL_SYMBOLS = "NIFTYBEES,BANKBEES,RELIANCE,TCS,HDFCBANK,ICICIBANK,INFY,SBIN";
const REFRESH_MS = Number(process.env.KITE_STREAM_REFRESH_SECONDS || 300) * 1000;
const MAX_SYMBOLS = Number(process.env.KITE_STREAM_MAX_SYMBOLS || 150);

function envList(name: string, fallback: string): string[] {
  return String(process.env[name] || fallback)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function uniqueSymbols(values: string[]): string[] {
  return [...new Set(values.map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

async function accessToken(): Promise<string> {
  const { data, error } = await db.from("system_settings").select("value").eq("key", "kite_access_token").maybeSingle();
  if (error) throw new Error(`Failed to read kite_access_token: ${error.message}`);
  if (!data?.value) throw new Error("kite_access_token missing; run kite-token-refresh first");
  return String(data.value);
}

async function loadInstruments(symbols: string[]): Promise<InstrumentRow[]> {
  if (!symbols.length) return [];
  const { data, error } = await db
    .from("kite_instruments")
    .select("tradingsymbol,instrument_token,exchange")
    .eq("exchange", "NSE")
    .eq("instrument_type", "EQ")
    .in("tradingsymbol", symbols);
  if (error) throw new Error(`Instrument lookup failed: ${error.message}`);
  return (data || []) as InstrumentRow[];
}

async function loadLifecycleSymbols(): Promise<string[]> {
  const { data, error } = await db
    .from("recommendation_lifecycle")
    .select("symbol,status,updated_at,created_at")
    .in("status", ["active", "pending_entry"])
    .order("updated_at", { ascending: false })
    .limit(250);
  if (error) {
    console.warn("kite-ws: lifecycle symbol load warning:", error.message);
    return [];
  }
  return (data || []).map((row) => String(row.symbol || ""));
}

async function loadRecentIdeaSymbols(): Promise<string[]> {
  const { data, error } = await db
    .from("trade_ideas")
    .select("symbol,created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.warn("kite-ws: recent idea symbol load warning:", error.message);
    return [];
  }
  return (data || []).map((row) => String(row.symbol || ""));
}

async function desiredSymbols(): Promise<string[]> {
  const manual = envList("KITE_STREAM_SYMBOLS", DEFAULT_MANUAL_SYMBOLS);
  const [lifecycle, recentIdeas] = await Promise.all([
    loadLifecycleSymbols(),
    loadRecentIdeaSymbols(),
  ]);
  return uniqueSymbols([...manual, ...lifecycle, ...recentIdeas]).slice(0, MAX_SYMBOLS);
}

async function upsertTicks(ticks: Tick[], byToken: Map<number, InstrumentRow>): Promise<void> {
  const now = new Date().toISOString();
  const rows = ticks.map((tick) => {
    const instrument = byToken.get(tick.instrument_token);
    const full = tick as any;
    return {
      instrument_token: tick.instrument_token,
      symbol: instrument?.tradingsymbol || null,
      exchange: instrument?.exchange || "NSE",
      last_price: tick.last_price ?? null,
      change_pct: full.change ?? null,
      volume_traded: full.volume_traded ?? null,
      average_traded_price: full.average_traded_price ?? null,
      total_buy_quantity: full.total_buy_quantity ?? null,
      total_sell_quantity: full.total_sell_quantity ?? null,
      oi: full.oi ?? null,
      ohlc: full.ohlc || {},
      depth: full.depth || {},
      exchange_timestamp: full.exchange_timestamp ? new Date(full.exchange_timestamp).toISOString() : null,
      received_at: now,
      source: "kite_websocket",
    };
  });
  if (!rows.length) return;
  const { error } = await db.from("live_ticks").upsert(rows, { onConflict: "instrument_token" });
  if (error) console.warn("live_ticks upsert warning:", error.message);
}

async function main() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("KITE_API_KEY is not set");

  const symbols = await desiredSymbols();
  const instruments = await loadInstruments(symbols);
  if (!instruments.length) throw new Error(`No NSE EQ instruments found for ${symbols.join(", ")}`);

  const byToken = new Map(instruments.map((row) => [Number(row.instrument_token), row]));
  let subscribedTokens = new Set<number>();
  const ticker = new KiteTicker({
    api_key: apiKey,
    access_token: await accessToken(),
    reconnect: true,
    max_retry: -1,
    max_delay: 5,
  });

  async function refreshSubscriptions() {
    const nextSymbols = await desiredSymbols();
    const nextInstruments = await loadInstruments(nextSymbols);
    const nextTokens = new Set(nextInstruments.map((row) => Number(row.instrument_token)));
    for (const row of nextInstruments) byToken.set(Number(row.instrument_token), row);

    const add = [...nextTokens].filter((token) => !subscribedTokens.has(token));
    const remove = [...subscribedTokens].filter((token) => !nextTokens.has(token));
    if (remove.length) {
      ticker.unsubscribe(remove);
      for (const token of remove) byToken.delete(token);
    }
    if (add.length) {
      ticker.subscribe(add);
      ticker.setMode(ticker.modeFull, add);
    }
    subscribedTokens = nextTokens;
    console.log(`kite-ws: streaming ${subscribedTokens.size} instruments (${nextSymbols.length} desired, +${add.length}/-${remove.length})`);
  }

  ticker.on("connect", () => {
    console.log("kite-ws: connected");
    void refreshSubscriptions();
  });
  ticker.on("ticks", (ticks) => {
    void upsertTicks(ticks, byToken);
  });
  ticker.on("reconnect", (count, interval) => console.warn(`kite-ws: reconnect ${count} in ${interval}s`));
  ticker.on("disconnect", (err) => console.warn("kite-ws: disconnected", err?.message || err));
  ticker.on("error", (err) => console.warn("kite-ws: error", err?.message || err));
  ticker.on("noreconnect", () => {
    console.error("kite-ws: reconnect exhausted");
    process.exitCode = 1;
  });

  ticker.connect();
  setInterval(() => void refreshSubscriptions(), REFRESH_MS);
}

main().catch((err) => {
  console.error("kite-ws: fatal", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
