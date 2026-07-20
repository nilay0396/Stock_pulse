import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const tradeIdeasRoutes = new Hono<{ Variables: Variables }>();

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

// GET /ideas
tradeIdeasRoutes.get("/", requireUser, async (c) => {
  const horizon = c.req.query("horizon");
  const direction = c.req.query("direction");
  const sector = c.req.query("sector");
  const minConviction = Number(c.req.query("min_conviction") || "0");
  const runIdParam = c.req.query("run_id");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || "50")));

  let query = db.from("trade_ideas").select("*");

  if (horizon) query = query.eq("horizon", horizon);
  if (direction) query = query.eq("direction", direction);
  if (sector) query = query.eq("sector", sector);
  if (minConviction) query = query.gte("conviction", minConviction);

  // Matches upstream behavior exactly: if no run_id is given AND there is
  // no successful report_run yet, the query has NO report_run_id filter at
  // all (returns across all ideas ever). Preserved intentionally.
  const runId = runIdParam || (await latestSuccessfulRunId());
  if (runId) query = query.eq("report_run_id", runId);

  const { data, error } = await query.order("conviction", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load trade ideas" }, 500);
  return c.json(data || []);
});

// GET /ideas/followups?status=active|resolved
tradeIdeasRoutes.get("/followups", requireUser, async (c) => {
  const status = c.req.query("status") || "active";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || "100")));
  let query = db.from("recommendation_lifecycle").select("*");

  if (status === "resolved") {
    query = query.in("status", ["hit_target", "hit_stop", "expired", "no_entry", "no_data", "error"]);
  } else if (status && status !== "all") {
    query = query.in("status", ["pending_entry", "active"]);
  }

  const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load recommendation follow-ups" }, 500);
  return c.json(data || []);
});

// GET /ideas/performance
tradeIdeasRoutes.get("/performance", requireUser, async (c) => {
  const { data, error } = await db
    .from("recommendation_lifecycle")
    .select("symbol,sector,horizon,direction,conviction,status,return_pct,days_active")
    .in("status", ["hit_target", "hit_stop", "expired", "no_entry", "no_data", "error"])
    .limit(1000);
  if (error) return c.json({ detail: "Failed to load recommendation performance" }, 500);

  const rows = data || [];
  const closed = rows.filter((r) => ["hit_target", "hit_stop", "expired"].includes(String(r.status)));
  const wins = closed.filter((r) => Number(r.return_pct || 0) > 0);
  const avg = (items: typeof rows, key: string) => items.length ? items.reduce((s, r) => s + Number((r as any)[key] || 0), 0) / items.length : 0;
  const bucket = (key: "horizon" | "sector" | "direction") => {
    const map = new Map<string, typeof rows>();
    for (const row of closed) {
      const k = String(row[key] || "Unknown");
      map.set(k, [...(map.get(k) || []), row]);
    }
    return [...map.entries()].map(([name, items]) => {
      const subWins = items.filter((r) => Number(r.return_pct || 0) > 0);
      return {
        name,
        count: items.length,
        hit_rate_pct: items.length ? Math.round((subWins.length / items.length) * 10000) / 100 : 0,
        avg_return_pct: Math.round(avg(items, "return_pct") * 1000) / 1000,
        avg_days: Math.round(avg(items, "days_active") * 100) / 100,
      };
    }).sort((a, b) => b.count - a.count);
  };

  return c.json({
    total: rows.length,
    closed: closed.length,
    active_sample_pending: rows.length - closed.length,
    hit_target: rows.filter((r) => r.status === "hit_target").length,
    hit_stop: rows.filter((r) => r.status === "hit_stop").length,
    no_entry: rows.filter((r) => r.status === "no_entry").length,
    hit_rate_pct: closed.length ? Math.round((wins.length / closed.length) * 10000) / 100 : 0,
    avg_return_pct: Math.round(avg(closed, "return_pct") * 1000) / 1000,
    by_horizon: bucket("horizon"),
    by_sector: bucket("sector").slice(0, 20),
    by_direction: bucket("direction"),
  });
});

// GET /ideas/scores
tradeIdeasRoutes.get("/scores", requireUser, async (c) => {
  const sector = c.req.query("sector");
  const direction = c.req.query("direction");
  const minConviction = Number(c.req.query("min_conviction") || "0");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") || "100")));

  const runId = await latestSuccessfulRunId();
  if (!runId) return c.json([]);

  let query = db.from("stock_scores").select("*").eq("report_run_id", runId);
  if (sector) query = query.eq("sector", sector);
  if (direction) query = query.eq("direction", direction);
  if (minConviction) query = query.gte("conviction", minConviction);

  const { data, error } = await query.order("conviction", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load scores" }, 500);
  return c.json(data || []);
});

// GET /ideas/scores/:symbol — NOT scoped to the latest report run, matches upstream.
tradeIdeasRoutes.get("/scores/:symbol", requireUser, async (c) => {
  const symbol = (c.req.param("symbol") ?? "").toUpperCase();

  const { data, error } = await db
    .from("stock_scores")
    .select("*")
    .eq("symbol", symbol)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ detail: "Failed to load score" }, 500);
  if (!data) return c.json({ detail: "No score found for symbol" }, 404);
  return c.json(data);
});

// GET /ideas/excluded?run_id=...
tradeIdeasRoutes.get("/excluded", requireUser, async (c) => {
  const runId = c.req.query("run_id");

  let query = db.from("report_runs").select("summary");
  query = runId ? query.eq("id", runId) : query.eq("status", "success");

  const { data: run, error } = await query
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ detail: "Failed to load excluded ideas" }, 500);
  if (!run) return c.json([]);

  const summary = (run.summary as Record<string, unknown>) || {};
  return c.json(summary.excluded_by_earnings ?? []);
});
