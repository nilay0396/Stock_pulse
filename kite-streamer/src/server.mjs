import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";
import kiteconnect from "kiteconnect";

const { KiteTicker } = kiteconnect;

const PORT = Number(process.env.PORT || 8787);
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const KITE_API_KEY = process.env.KITE_API_KEY || "";
const DIRECT_ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || "";

if (!KITE_API_KEY) {
  throw new Error("KITE_API_KEY is required");
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const clients = new Map();
const tokenToSymbol = new Map();
let ticker = null;
let activeTokens = new Set();

async function loadAccessToken() {
  if (DIRECT_ACCESS_TOKEN) return DIRECT_ACCESS_TOKEN;
  if (!supabase) throw new Error("Set KITE_ACCESS_TOKEN or Supabase service credentials");

  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "kite_access_token")
    .maybeSingle();
  if (error) throw error;
  const value = data?.value;
  if (typeof value === "string") return value;
  if (value?.access_token) return value.access_token;
  throw new Error("No kite_access_token found in system_settings");
}

async function resolveSymbols(symbols) {
  if (!supabase) throw new Error("Supabase credentials are required for symbol lookup");
  const normalized = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!normalized.length) return [];

  const { data, error } = await supabase
    .from("kite_instruments")
    .select("tradingsymbol,instrument_token")
    .eq("exchange", "NSE")
    .eq("instrument_type", "EQ")
    .in("tradingsymbol", normalized);
  if (error) throw error;

  return (data || []).map((row) => {
    const token = Number(row.instrument_token);
    tokenToSymbol.set(token, row.tradingsymbol);
    return token;
  });
}

async function ensureTicker() {
  if (ticker) return ticker;
  const accessToken = await loadAccessToken();
  ticker = new KiteTicker({ api_key: KITE_API_KEY, access_token: accessToken });

  ticker.on("connect", () => {
    const tokens = [...activeTokens];
    if (tokens.length) {
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeFull, tokens);
    }
    console.log(`kite-streamer: connected (${tokens.length} active tokens)`);
  });

  ticker.on("ticks", (ticks) => {
    for (const tick of ticks || []) {
      const token = Number(tick.instrument_token);
      const symbol = tokenToSymbol.get(token);
      const payload = JSON.stringify({ type: "tick", symbol, tick });
      for (const [ws, state] of clients.entries()) {
        if (state.tokens.has(token) && ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  });

  ticker.on("error", (err) => console.error("kite-streamer: ticker error", err));
  ticker.on("close", () => console.warn("kite-streamer: ticker closed"));
  ticker.connect();
  return ticker;
}

function resubscribe() {
  if (!ticker) return;
  const nextTokens = new Set();
  for (const state of clients.values()) {
    for (const token of state.tokens) nextTokens.add(token);
  }
  const oldTokens = activeTokens;
  const subscribe = [...nextTokens].filter((t) => !oldTokens.has(t));
  const unsubscribe = [...oldTokens].filter((t) => !nextTokens.has(t));
  activeTokens = nextTokens;

  if (subscribe.length) {
    ticker.subscribe(subscribe);
    ticker.setMode(ticker.modeFull, subscribe);
  }
  if (unsubscribe.length) ticker.unsubscribe(unsubscribe);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: clients.size, tokens: activeTokens.size }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "Not found" }));
});

const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("connection", async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const symbols = (url.searchParams.get("symbols") || "").split(",");
    const tokens = await resolveSymbols(symbols);
    clients.set(ws, { tokens: new Set(tokens) });
    ws.send(JSON.stringify({ type: "subscribed", symbols: symbols.filter(Boolean), tokens }));
    await ensureTicker();
    resubscribe();
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", detail: err instanceof Error ? err.message : String(err) }));
    ws.close();
  }

  ws.on("close", () => {
    clients.delete(ws);
    resubscribe();
  });
});

server.listen(PORT, () => {
  console.log(`kite-streamer: listening on :${PORT}`);
});
