import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const flowsRoutes = new Hono<{ Variables: Variables }>();

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Number(raw || String(fallback))));
}

// GET /flows/fii-dii?limit=30
flowsRoutes.get("/fii-dii", requireUser, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 30, 200);
  const { data, error } = await db
    .from("fii_dii_flows")
    .select("*")
    .order("ingested_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load FII/DII flows" }, 500);
  return c.json(data || []);
});

// GET /flows/insider?symbol=&limit=50
flowsRoutes.get("/insider", requireUser, async (c) => {
  const symbol = c.req.query("symbol");
  const limit = clampLimit(c.req.query("limit"), 50, 200);
  let query = db.from("insider_trades").select("*");
  if (symbol) query = query.eq("symbol", symbol.toUpperCase());
  const { data, error } = await query.order("disclosure_date", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load insider trades" }, 500);
  return c.json(data || []);
});

// GET /flows/geopolitics?limit=30
flowsRoutes.get("/geopolitics", requireUser, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 30, 200);
  const { data, error } = await db
    .from("geopolitics_events")
    .select("*")
    .order("ingested_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load geopolitics events" }, 500);
  return c.json(data || []);
});

// GET /flows/delivery/:symbol?limit=30
flowsRoutes.get("/delivery/:symbol", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") ?? "").toUpperCase();
  const limit = clampLimit(c.req.query("limit"), 30, 200);
  const { data, error } = await db
    .from("bhavcopy_rows")
    .select("*")
    .eq("symbol", symbol)
    .order("as_of", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load delivery data" }, 500);
  return c.json(data || []);
});

// GET /flows/sector-indices
// Truncate-and-reload table (whole table == latest snapshot). Sort matches
// upstream's in-Python sort exactly: treats a null change_pct as 0, done in
// JS rather than SQL because that's what the Python source itself does.
flowsRoutes.get("/sector-indices", requireUser, async (c) => {
  const { data, error } = await db.from("sector_indices").select("*").limit(200);
  if (error) return c.json({ detail: "Failed to load sector indices" }, 500);
  const rows = (data || []).slice().sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
  return c.json(rows);
});

// GET /flows/corporate-announcements?symbol=&limit=60
flowsRoutes.get("/corporate-announcements", requireUser, async (c) => {
  const symbol = c.req.query("symbol");
  const limit = clampLimit(c.req.query("limit"), 60, 200);
  let query = db.from("corp_announcements").select("*");
  if (symbol) query = query.eq("symbol", symbol.toUpperCase());
  const { data, error } = await query.order("disclosure_time", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load corporate announcements" }, 500);
  return c.json(data || []);
});

// GET /flows/corporate-actions?symbol=&limit=100 — ascending (soonest first)
flowsRoutes.get("/corporate-actions", requireUser, async (c) => {
  const symbol = c.req.query("symbol");
  const limit = clampLimit(c.req.query("limit"), 100, 300);
  let query = db.from("corp_actions").select("*");
  if (symbol) query = query.eq("symbol", symbol.toUpperCase());
  const { data, error } = await query.order("ex_date", { ascending: true }).limit(limit);
  if (error) return c.json({ detail: "Failed to load corporate actions" }, 500);
  return c.json(data || []);
});

// GET /flows/shareholding/:symbol — hardcoded limit of 12, not user-configurable.
flowsRoutes.get("/shareholding/:symbol", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") ?? "").toUpperCase();
  const { data, error } = await db
    .from("shareholding_filings")
    .select("*")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(12);
  if (error) return c.json({ detail: "Failed to load shareholding filings" }, 500);
  return c.json(data || []);
});

// GET /flows/fred — hardcoded limit of 50, not user-configurable.
flowsRoutes.get("/fred", requireUser, async (c) => {
  const { data, error } = await db
    .from("fred_macro")
    .select("*")
    .order("ingested_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ detail: "Failed to load FRED series" }, 500);
  return c.json(data || []);
});

// GET /flows/fmp/:symbol — single latest doc, or null.
flowsRoutes.get("/fmp/:symbol", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") ?? "").toUpperCase();
  const { data, error } = await db
    .from("fmp_fundamentals")
    .select("*")
    .eq("symbol", symbol)
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return c.json({ detail: "Failed to load FMP fundamentals" }, 500);
  return c.json(data ?? null);
});

// GET /flows/financial-results?symbol=&limit=200 — ascending (soonest board-meeting first)
flowsRoutes.get("/financial-results", requireUser, async (c) => {
  const symbol = c.req.query("symbol");
  const limit = clampLimit(c.req.query("limit"), 200, 500);
  let query = db.from("financial_results").select("*");
  if (symbol) query = query.eq("symbol", symbol.toUpperCase());
  const { data, error } = await query.order("bm_date", { ascending: true }).limit(limit);
  if (error) return c.json({ detail: "Failed to load financial results" }, 500);
  return c.json(data || []);
});
