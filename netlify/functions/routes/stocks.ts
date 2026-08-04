import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";
import { fetchEquityOhlcDated, fetchQuoteSummaryInfo, fetchYahooSearchNews } from "../lib/market/yahoo.js";
import { computeSnapshot } from "../lib/scoring/indicators.js";
import { entryStopTarget } from "../lib/scoring/scoring.js";
import { getAuthenticatedKiteClient } from "../lib/kite/client.js";
import { fetchOptionChain } from "../lib/kite/optionChain.js";
import { fetchHistoricalBarsDated } from "../lib/kite/historical.js";
import { fetchRssNews } from "../lib/connectors/rssNews.js";
import { fallbackStockDeepDiveMemo, generateStockDeepDiveMemo, llmAvailable } from "../lib/llm/anthropic.js";

type Variables = { user: PublicUser };
export const stocksRoutes = new Hono<{ Variables: Variables }>();

type Dict = Record<string, any>;
type ChartInterval = "minute" | "5minute" | "15minute" | "60minute" | "day";

async function latestSuccessfulRunId(): Promise<string | null> {
  const { data } = await db
    .from("report_runs")
    .select("id")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function safe<T>(label: string, promise: Promise<T>, fallback: T, warnings: Dict[]): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const message = errorMessage(err);
    console.warn(`stock-deep-dive: ${label} failed:`, message);
    warnings.push({ source: label, error: message });
    return fallback;
  }
}

async function latestLiveTick(symbol: string): Promise<Dict | null> {
  const { data, error } = await db
    .from("live_ticks")
    .select("*")
    .eq("symbol", symbol)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function recommendationFollowups(symbol: string): Promise<Dict> {
  const { data, error } = await db
    .from("recommendation_lifecycle")
    .select("trade_idea_id,report_run_id,original_run_date,symbol,name,direction,horizon,conviction,entry_low,entry_high,stop_loss,target_low,target_high,status,current_price,entry_date,entry_price,exit_date,exit_price,return_pct,days_active,status_note,ai_followup,updated_at")
    .eq("symbol", symbol)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) return { active: [], resolved: [], error: error.message };
  const rows = data || [];
  const activeStatuses = new Set(["active", "pending_entry", "target_1_hit", "trailing"]);
  const active = rows.filter((row) => activeStatuses.has(String(row.status))).slice(0, 8);
  const resolved = rows.filter((row) => !activeStatuses.has(String(row.status))).slice(0, 8);
  return { active, resolved };
}

async function stockMemoWithFallback(payload: Dict, skipLlm: boolean): Promise<{ text: string; source: "llm" | "fallback"; error?: string }> {
  const fallback = fallbackStockDeepDiveMemo(payload);
  if (skipLlm || !llmAvailable()) return { text: fallback, source: "fallback" };
  try {
    const text = await withTimeout("ai_memo", generateStockDeepDiveMemo(payload), 15000);
    return { text: text || fallback, source: text ? "llm" : "fallback", error: text ? undefined : "empty_memo" };
  } catch (err) {
    return { text: fallback, source: "fallback", error: errorMessage(err) };
  }
}

function chartConfig(inputInterval?: string, inputRange?: string): { interval: ChartInterval; days: number; label: string } {
  const key = (inputInterval || "1d").toLowerCase();
  if (key === "1m" || key === "minute") return { interval: "minute", days: inputRange === "5d" ? 5 : 2, label: "1m" };
  if (key === "5m" || key === "5minute") return { interval: "5minute", days: inputRange === "30d" ? 30 : 10, label: "5m" };
  if (key === "15m" || key === "15minute") return { interval: "15minute", days: inputRange === "60d" ? 60 : 30, label: "15m" };
  if (key === "1h" || key === "60minute") return { interval: "60minute", days: inputRange === "180d" ? 180 : 90, label: "1h" };
  if (key === "1mo" || key === "1month" || key === "month") return { interval: "day", days: inputRange === "10y" ? 3650 : 1825, label: "1mo" };
  return { interval: "day", days: inputRange === "1y" ? 370 : inputRange === "3mo" ? 110 : 190, label: "1d" };
}

function aggregateMonthlyCandles(candles: Dict[]): Dict[] {
  const monthly = new Map<string, Dict>();
  for (const candle of candles) {
    if (!candle?.date || candle.close == null || candle.high == null || candle.low == null) continue;
    const month = String(candle.date).slice(0, 7);
    const existing = monthly.get(month);
    if (!existing) {
      monthly.set(month, {
        date: month,
        open: candle.open ?? candle.close,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? 0,
      });
      continue;
    }
    existing.high = Math.max(Number(existing.high), Number(candle.high));
    existing.low = Math.min(Number(existing.low), Number(candle.low));
    existing.close = candle.close;
    existing.volume = Number(existing.volume || 0) + Number(candle.volume || 0);
  }
  return Array.from(monthly.values());
}

function isSearchableEquity(row: Dict): boolean {
  const symbol = String(row.symbol || "").toUpperCase();
  const name = String(row.name || "").toUpperCase();
  if (!symbol || /^\d/.test(symbol)) return false;
  if (symbol.includes("-")) return false;
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
  return !blockedNameTokens.some((token) => name.includes(token));
}

function searchRank(row: Dict, needle: string): number {
  const q = needle.toUpperCase();
  const symbol = String(row.symbol || "").toUpperCase();
  const name = String(row.name || "").toUpperCase();
  if (symbol === q) return 0;
  if (symbol.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (symbol.includes(q)) return 3;
  if (name.includes(q)) return 4;
  return 9;
}

function verdictFor(score: Dict | null, horizon: "weekly" | "monthly"): "buy" | "hold" | "sell" | "avoid" {
  if (!score) return "hold";
  if (score.direction === "avoid") return "avoid";
  if (score.direction === "bearish") return score.conviction >= 70 ? "sell" : "hold";
  const gate = horizon === "weekly" ? 72 : 75;
  return score.conviction >= gate ? "buy" : "hold";
}

function buildPlan(snapshot: Dict, score: Dict | null, horizon: "weekly" | "monthly"): Dict {
  const direction = score?.direction || "watch";
  const last = snapshot.last_close || 0;
  if (!last) return { verdict: "avoid", horizon_days: horizon === "weekly" ? 10 : 35, plan: {} };
  const levels = entryStopTarget(last, snapshot.atr_14 ?? null, direction, horizon);
  return {
    verdict: verdictFor(score, horizon),
    horizon_days: horizon === "weekly" ? 10 : 35,
    plan: {
      entry_low: levels.entry_low,
      entry_high: levels.entry_high,
      stop_loss: levels.stop_loss,
      target_1: levels.target_low,
      target_2: levels.target_high,
      rr: levels.risk_reward,
    },
  };
}

function mapNews(row: Dict): Dict {
  return {
    title: row.headline,
    link: row.url,
    source: row.source,
    publisher: row.source,
    published: row.published_at,
    published_at: row.published_at,
    ingested_at: row.ingested_at,
    sentiment: row.sentiment,
    category: row.category,
  };
}

function analyseOptionChain(chain: Dict): Dict {
  const calls = Array.isArray(chain.calls) ? chain.calls : [];
  const puts = Array.isArray(chain.puts) ? chain.puts : [];
  const totalCallOi = calls.reduce((s: number, c: Dict) => s + Number(c.oi || 0), 0);
  const totalPutOi = puts.reduce((s: number, p: Dict) => s + Number(p.oi || 0), 0);
  const byOi = (a: Dict, b: Dict) => Number(b.oi || 0) - Number(a.oi || 0);
  const maxCall = [...calls].sort(byOi)[0] || {};
  const maxPut = [...puts].sort(byOi)[0] || {};
  const pcr = totalCallOi ? totalPutOi / totalCallOi : null;
  return {
    total_call_oi: totalCallOi,
    total_put_oi: totalPutOi,
    pcr,
    atm_strike: chain.underlying
      ? [...calls, ...puts].map((c: Dict) => c.strike).sort((a: number, b: number) => Math.abs(a - chain.underlying) - Math.abs(b - chain.underlying))[0]
      : null,
    max_oi_call_strike: maxCall.strike ?? null,
    max_oi_put_strike: maxPut.strike ?? null,
    nearest_expiry: chain.expiries?.[0] ?? null,
    top_calls: [...calls].sort(byOi).slice(0, 8),
    top_puts: [...puts].sort(byOi).slice(0, 8),
    bias: pcr == null ? "neutral" : pcr > 1.15 ? "bullish" : pcr < 0.85 ? "bearish" : "neutral",
    confidence: pcr == null ? 0 : Math.min(1, Math.abs(pcr - 1)),
  };
}

function fallbackAiSummary(universe: Dict, snapshot: Dict, score: Dict | null, news: Dict[]): string {
  const lines = [
    `${universe.symbol} is in ${universe.sector || "Other"} with latest close around ₹${snapshot.last_close ?? "—"}.`,
    score
      ? `Latest pipeline conviction is ${Number(score.conviction || 0).toFixed(1)}/100 with ${score.direction || "neutral"} direction.`
      : "This symbol has no latest pipeline score yet, so treat the view as technical/data-only until the next report run.",
  ];
  if (score?.reasons?.length) lines.push(`Main supports: ${score.reasons.slice(0, 3).join("; ")}.`);
  if (score?.risks?.length) lines.push(`Key risks: ${score.risks.slice(0, 3).join("; ")}.`);
  if (news.length) lines.push(`Recent headlines loaded: ${news.length}.`);
  return lines.join("\n");
}

// GET /stocks/universe?limit=5000
stocksRoutes.get("/universe", requireUser, async (c) => {
  const limit = Number(c.req.query("limit") || "5000");
  const { data, error } = await db.from("stock_universe").select("*").limit(limit);
  if (error) return c.json({ detail: "Failed to load universe" }, 500);
  return c.json(data || []);
});

// GET /stocks/universe/stats — lightweight counts, avoids pulling ~2,000 rows
// over the wire just to compute total / curated / "Other" splits.
stocksRoutes.get("/universe/stats", requireUser, async (c) => {
  const total = await db.from("stock_universe").select("*", { count: "exact", head: true });
  const curated = await db
    .from("stock_universe")
    .select("*", { count: "exact", head: true })
    .not("sector", "in", "(Other)")
    .not("sector", "is", null);
  const other = await db
    .from("stock_universe")
    .select("*", { count: "exact", head: true })
    .eq("sector", "Other");

  if (total.error || curated.error || other.error) {
    return c.json({ detail: "Failed to load universe stats" }, 500);
  }
  return c.json({ total: total.count ?? 0, curated: curated.count ?? 0, other: other.count ?? 0 });
});

stocksRoutes.get("/sectors", requireUser, async (c) => {
  const rows: Dict[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("stock_universe").select("sector").range(from, from + 999);
    if (error) return c.json({ detail: "Failed to load sectors" }, 500);
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    const sector = row.sector || "Other";
    counts.set(sector, (counts.get(sector) || 0) + 1);
  }
  return c.json([...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => {
    if (a.name === "Other") return 1;
    if (b.name === "Other") return -1;
    return a.name.localeCompare(b.name);
  }));
});

// GET /stocks/explorer
// Universe-first explorer endpoint. Browsing/searching starts from
// stock_universe so unscored names remain visible; conviction filters switch
// to the latest score set because unscored rows do not have a conviction.
stocksRoutes.get("/explorer", requireUser, async (c) => {
  const q = (c.req.query("q") || "").trim();
  const sector = c.req.query("sector") || "";
  const scored = c.req.query("scored") || "all";
  const minConviction = Number(c.req.query("min_conviction") || "0");
  const limit = Math.min(100, Math.max(10, Number(c.req.query("limit") || "50")));
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));
  const needle = q.replace(/[%_]/g, "");
  const runId = await latestSuccessfulRunId();
  const scoreMode = scored === "scored" || minConviction > 0;

  let total = 0;
  let universeRows: Dict[] = [];
  let scoreRows: Dict[] = [];

  if (scoreMode && runId) {
    let scoreQuery = db.from("stock_scores").select("*").eq("report_run_id", runId);
    if (minConviction) scoreQuery = scoreQuery.gte("conviction", minConviction);
    const { data: allScores, error: scoreError } = await scoreQuery.order("conviction", { ascending: false }).limit(1000);
    if (scoreError) return c.json({ detail: "Failed to load explorer scores" }, 500);

    const scoreSymbols = (allScores || []).map((row) => row.symbol).filter(Boolean);
    const { data: universes, error: universeError } = scoreSymbols.length
      ? await db.from("stock_universe").select("*").in("symbol", scoreSymbols)
      : { data: [], error: null };
    if (universeError) return c.json({ detail: "Failed to load explorer universe rows" }, 500);

    const universeBySymbol = new Map((universes || []).map((row) => [row.symbol, row]));
    const filteredScores = (allScores || []).filter((scoreRow) => {
      const universe = universeBySymbol.get(scoreRow.symbol) || {};
      if (sector && universe.sector !== sector) return false;
      if (needle) {
        const hay = `${scoreRow.symbol || ""} ${universe.name || ""}`.toLowerCase();
        if (!hay.includes(needle.toLowerCase())) return false;
      }
      return true;
    });
    total = filteredScores.length;
    scoreRows = filteredScores.slice(offset, offset + limit);
    const pageSymbols = scoreRows.map((row) => row.symbol);
    universeRows = pageSymbols.map((symbol) => universeBySymbol.get(symbol)).filter(Boolean);
  } else {
    let universeQuery = db.from("stock_universe").select("*", { count: "exact" });
    if (sector) universeQuery = universeQuery.eq("sector", sector);
    if (needle) universeQuery = universeQuery.or(`symbol.ilike.%${needle}%,name.ilike.%${needle}%`);
    if (scored === "unscored" && runId) {
      const { data: scoredSymbols, error: scoredError } = await db
        .from("stock_scores")
        .select("symbol")
        .eq("report_run_id", runId)
        .limit(1000);
      if (scoredError) return c.json({ detail: "Failed to load scored symbols" }, 500);
      const known = (scoredSymbols || []).map((row) => row.symbol).filter(Boolean);
      if (known.length) universeQuery = universeQuery.not("symbol", "in", `(${known.map((symbol) => `"${symbol}"`).join(",")})`);
    }
    const { data, error, count } = await universeQuery.order("symbol", { ascending: true }).range(offset, offset + limit - 1);
    if (error) return c.json({ detail: "Failed to load explorer universe" }, 500);
    universeRows = data || [];
    total = count ?? 0;

    if (runId && universeRows.length) {
      const pageSymbols = universeRows.map((row) => row.symbol);
      const scores = await db.from("stock_scores").select("*").eq("report_run_id", runId).in("symbol", pageSymbols);
      if (scores.error) return c.json({ detail: "Failed to load explorer scores" }, 500);
      scoreRows = scores.data || [];
    }
  }

  const pageSymbols = universeRows.map((row) => row.symbol).filter(Boolean);
  const [{ data: technicalRows }, { count: universeCount }, { count: latestScoreCount }] = await Promise.all([
    pageSymbols.length ? db.from("technical_snapshots").select("*").in("symbol", pageSymbols) : Promise.resolve({ data: [] }),
    db.from("stock_universe").select("*", { count: "exact", head: true }),
    runId ? db.from("stock_scores").select("*", { count: "exact", head: true }).eq("report_run_id", runId) : Promise.resolve({ count: 0 }),
  ]);

  const scoreBySymbol = new Map((scoreRows || []).map((row) => [row.symbol, row]));
  const technicalBySymbol = new Map((technicalRows || []).map((row) => [row.symbol, row]));
  const rows = universeRows.map((universe) => {
    const score = scoreBySymbol.get(universe.symbol) || null;
    const technical = technicalBySymbol.get(universe.symbol) || null;
    return {
      symbol: universe.symbol,
      name: universe.name,
      yf_symbol: universe.yf_symbol,
      sector: universe.sector,
      industry: universe.industry,
      market_cap_tier: universe.market_cap_tier,
      scored: Boolean(score),
      has_technicals: Boolean(technical),
      score,
      technicals: technical,
      data_state: {
        sector_known: Boolean(universe.sector && universe.sector !== "Other"),
        industry_known: Boolean(universe.industry && universe.industry !== "Unknown"),
        scored: Boolean(score),
        technicals: Boolean(technical),
      },
    };
  });

  return c.json({
    rows,
    total,
    limit,
    offset,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    latest_report_run_id: runId,
    universe_total: universeCount ?? 0,
    latest_scored_rows: latestScoreCount ?? 0,
    scored_coverage_pct: universeCount ? Math.round(((latestScoreCount || 0) / universeCount) * 10000) / 100 : 0,
  });
});

// GET /stocks/search?q=rel&limit=10
stocksRoutes.get("/search", requireUser, async (c) => {
  const q = (c.req.query("q") || "").trim();
  const limit = Math.min(25, Math.max(1, Number(c.req.query("limit") || "10")));
  if (!q) return c.json([]);
  const needle = q.replace(/[%_]/g, "");
  const { data, error } = await db
    .from("stock_universe")
    .select("symbol,yf_symbol,name,sector,industry,market_cap_tier")
    .or(`symbol.ilike.%${needle}%,name.ilike.%${needle}%`)
    .order("symbol", { ascending: true })
    .limit(Math.max(100, limit * 10));
  if (error) return c.json({ detail: "Failed to search stocks" }, 500);
  const rows = (data || [])
    .filter(isSearchableEquity)
    .sort((a, b) => {
      const rank = searchRank(a, needle) - searchRank(b, needle);
      if (rank !== 0) return rank;
      return String(a.symbol).localeCompare(String(b.symbol));
    })
    .slice(0, limit);
  return c.json(rows);
});

async function latestScore(symbol: string): Promise<Dict | null> {
  const { data } = await db
    .from("stock_scores")
    .select("*")
    .eq("symbol", symbol)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function latestSnapshot(symbol: string): Promise<Dict | null> {
  const { data } = await db
    .from("technical_snapshots")
    .select("*")
    .eq("symbol", symbol)
    .maybeSingle();
  return data || null;
}

async function stockNews(symbol: string, limit = 20, universe?: Dict): Promise<Dict[]> {
  const { data } = await db
    .from("news_items")
    .select("*")
    .eq("symbol", symbol)
    .order("ingested_at", { ascending: false })
    .limit(limit);
  const stored = (data || []).map(mapNews);

  const [rss, yahoo] = await Promise.all([
    universe ? fetchRssNews([{ symbol, name: universe.name }], 20).catch(() => []) : Promise.resolve([]),
    fetchYahooSearchNews(`${symbol}.NS ${universe?.name || ""}`, 10).catch(() => []),
  ]);

  const liveRss = rss
    .filter((item) => item.matched_symbols.includes(symbol))
    .map((item) => ({
      title: item.title,
      link: item.link,
      source: item.source,
      publisher: item.source,
      published: item.pub_date,
      published_at: item.pub_date,
      ingested_at: item.ingested_at,
      category: item.scope,
      sentiment: null,
    }));
  const yahooNews = yahoo.map((item) => ({
    title: item.title,
    link: item.link,
    source: item.publisher || "Yahoo Finance",
    publisher: item.publisher || "Yahoo Finance",
    published: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : null,
    published_at: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : null,
    ingested_at: new Date().toISOString(),
    category: "market",
    sentiment: null,
  }));

  const seen = new Set<string>();
  return [...stored, ...liveRss, ...yahooNews].filter((item) => {
    const key = String(item.title || "").toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

async function stockEvents(symbol: string): Promise<Dict> {
  const [ann, actions] = await Promise.all([
    db.from("corp_announcements").select("*").eq("symbol", symbol).order("ingested_at", { ascending: false }).limit(10),
    db.from("corp_actions").select("*").eq("symbol", symbol).order("ingested_at", { ascending: false }).limit(10),
  ]);
  return {
    next_earnings: null,
    announcements: ann.data || [],
    actions: actions.data || [],
  };
}

async function stockFno(symbol: string): Promise<Dict> {
  const providersTried: Dict[] = [];
  try {
    const kc = await getAuthenticatedKiteClient();
    const chain = await fetchOptionChain(kc, symbol);
    if (!chain.eligible) {
      providersTried.push({ provider: "kite", error: chain.error || "not eligible" });
      return { eligible: false, source: "none", providers_tried: providersTried };
    }
    return {
      eligible: true,
      source: "kite",
      fetched_at: chain.fetched_at,
      underlying: chain.underlying,
      analytics: analyseOptionChain(chain),
    };
  } catch (err) {
    providersTried.push({ provider: "kite", error: err instanceof Error ? err.message : String(err) });
    return { eligible: false, source: "none", providers_tried: providersTried };
  }
}

async function stockOhlc(
  symbol: string,
  days = 370,
  interval: ChartInterval = "day",
): Promise<{ candles: Dict[]; source: "kite" | "yahoo" | "none"; interval: ChartInterval }> {
  try {
    const kc = await getAuthenticatedKiteClient();
    const kiteCandles = await fetchHistoricalBarsDated(kc, symbol, days, interval);
    if (kiteCandles && kiteCandles.length) return { candles: kiteCandles, source: "kite", interval };
  } catch {
    // Fall through to Yahoo; Deep Dive should remain usable if Kite auth expires.
  }

  const yahooCandles = await fetchEquityOhlcDated(symbol, days).catch(() => []);
  if (yahooCandles.length) return { candles: yahooCandles, source: "yahoo", interval: "day" };
  return { candles: [], source: "none", interval };
}

// POST /stocks/:symbol/deep-dive
stocksRoutes.post("/:symbol/deep-dive", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") || "").toUpperCase();
  const body = (await c.req.json().catch(() => ({}))) as Dict;
  const cfg = chartConfig(body.interval, body.range);
  const aggregateMonthly = cfg.label === "1mo";
  const warnings: Dict[] = [];
  const { data: universe, error: universeError } = await db
    .from("stock_universe")
    .select("*")
    .eq("symbol", symbol)
    .maybeSingle();
  if (universeError) return c.json({ detail: "Failed to load stock" }, 500);
  if (!universe) return c.json({ detail: "Stock not found" }, 404);

  const [ohlcResult, fundamentalsMap, storedSnapshot, score, news, events, fno, liveTick, followups] = await Promise.all([
    safe("ohlc", withTimeout("ohlc", stockOhlc(symbol, cfg.days, cfg.interval), 3500), { candles: [], source: "none", interval: cfg.interval } as { candles: Dict[]; source: "kite" | "yahoo" | "none"; interval: ChartInterval }, warnings),
    safe("fundamentals", withTimeout("fundamentals", fetchQuoteSummaryInfo([symbol]), 2200), {} as Record<string, Record<string, any>>, warnings),
    safe("stored_snapshot", latestSnapshot(symbol), null, warnings),
    safe("score", latestScore(symbol), null, warnings),
    safe("news", withTimeout("news", stockNews(symbol, 25, universe), 2200), [] as Dict[], warnings),
    safe("events", withTimeout("events", stockEvents(symbol), 1500), { next_earnings: null, announcements: [], actions: [] }, warnings),
    safe("fno", withTimeout("fno", stockFno(symbol), 1800), { eligible: false, source: "none", providers_tried: [{ provider: "kite", error: "Timed out or unavailable" }] }, warnings),
    safe("live_tick", latestLiveTick(symbol), null, warnings),
    safe("followups", recommendationFollowups(symbol), { active: [], resolved: [] }, warnings),
  ]);

  const ohlc = aggregateMonthly ? aggregateMonthlyCandles(ohlcResult.candles) : ohlcResult.candles;
  const computedSnapshot = await safe("technicals", Promise.resolve(ohlc.length ? computeSnapshot(ohlc.map((b) => ({
      close: b.close,
      high: b.high,
      low: b.low,
      volume: b.volume,
    }))) : {}), {}, warnings);
  const technicals = {
    ...(storedSnapshot || {}),
    ...computedSnapshot,
    ...(liveTick?.last_price ? {
      last_close: liveTick.last_price,
      change_pct_1d: liveTick.change_pct ?? computedSnapshot.change_pct_1d,
      live_received_at: liveTick.received_at,
      live_source: liveTick.source,
    } : {}),
  };
  const fundamentals = (fundamentalsMap as Record<string, Record<string, any>>)[symbol] || {};
  const sector = universe.sector === "Other" && fundamentals.sector ? fundamentals.sector : universe.sector;
  const industry = universe.industry === "Unknown" && fundamentals.industry ? fundamentals.industry : universe.industry;
  const memoPayload = {
    symbol,
    name: universe.name,
    sector,
    industry,
    technicals,
    fundamentals,
    score,
    weekly: buildPlan(technicals, score, "weekly"),
    monthly: buildPlan(technicals, score, "monthly"),
    news,
    events,
    fno,
  };
  const memo = await stockMemoWithFallback(memoPayload, Boolean(body.skip_llm));

  return c.json({
    symbol,
    name: universe.name,
    sector,
    industry,
    market_cap_tier: universe.market_cap_tier,
    ohlc,
    chart_source: ohlcResult.source,
    chart_interval: aggregateMonthly ? "month" : ohlcResult.interval,
    chart_label: cfg.label,
    technicals,
    fundamentals,
    score,
    weekly: buildPlan(technicals, score, "weekly"),
    monthly: buildPlan(technicals, score, "monthly"),
    news,
    sentiment: { avg_sentiment: 0, items: news.map((n) => ({ title: n.title, sentiment: n.sentiment ?? 0, category: n.category || "other" })) },
    events,
    fno,
    live_tick: liveTick,
    followups,
    ai_summary: memo.text,
    ai_memo_source: memo.source,
    ai_memo_error: memo.error || null,
    data_warnings: warnings,
    from_cache: false,
  });
});

// GET /stocks/:symbol
stocksRoutes.get("/:symbol", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") || "").toUpperCase();
  const [{ data: universe }, technicals, score, news] = await Promise.all([
    db.from("stock_universe").select("*").eq("symbol", symbol).maybeSingle(),
    latestSnapshot(symbol),
    latestScore(symbol),
    stockNews(symbol, 10),
  ]);
  if (!universe) return c.json({ universe: null });
  return c.json({ universe, technicals, score, news });
});

// GET /stocks/:symbol/history?period=6mo
stocksRoutes.get("/:symbol/history", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") || "").toUpperCase();
  const period = c.req.query("period") || "6mo";
  const cfg = chartConfig(c.req.query("interval"), period);
  const aggregateMonthly = cfg.label === "1mo";
  const { candles, source, interval } = await stockOhlc(symbol, cfg.days, cfg.interval);
  return c.json({
    symbol,
    candles: aggregateMonthly ? aggregateMonthlyCandles(candles) : candles,
    source,
    interval: aggregateMonthly ? "month" : interval,
    label: cfg.label,
  });
});
