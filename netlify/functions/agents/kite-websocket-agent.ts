import { KiteTicker, type Tick } from "kiteconnect";
import { db } from "../lib/db.js";

type InstrumentRow = {
  tradingsymbol: string;
  instrument_token: number;
  exchange: string;
};

function envList(name: string, fallback: string): string[] {
  return String(process.env[name] || fallback)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function accessToken(): Promise<string> {
  const { data, error } = await db.from("system_settings").select("value").eq("key", "kite_access_token").maybeSingle();
  if (error) throw new Error(`Failed to read kite_access_token: ${error.message}`);
  if (!data?.value) throw new Error("kite_access_token missing; run kite-token-refresh first");
  return String(data.value);
}

async function loadInstruments(symbols: string[]): Promise<InstrumentRow[]> {
  const { data, error } = await db
    .from("kite_instruments")
    .select("tradingsymbol,instrument_token,exchange")
    .eq("exchange", "NSE")
    .eq("instrument_type", "EQ")
    .in("tradingsymbol", symbols);
  if (error) throw new Error(`Instrument lookup failed: ${error.message}`);
  return (data || []) as InstrumentRow[];
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

  const symbols = envList("KITE_STREAM_SYMBOLS", "NIFTYBEES,BANKBEES,RELIANCE,TCS,HDFCBANK,ICICIBANK,INFY,SBIN");
  const instruments = await loadInstruments(symbols);
  if (!instruments.length) throw new Error(`No NSE EQ instruments found for ${symbols.join(", ")}`);

  const byToken = new Map(instruments.map((row) => [Number(row.instrument_token), row]));
  const tokens = [...byToken.keys()];
  const ticker = new KiteTicker({
    api_key: apiKey,
    access_token: await accessToken(),
    reconnect: true,
    max_retry: -1,
    max_delay: 5,
  });

  ticker.on("connect", () => {
    console.log(`kite-ws: connected; subscribing ${tokens.length} instruments`);
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens);
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
}

main().catch((err) => {
  console.error("kite-ws: fatal", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
