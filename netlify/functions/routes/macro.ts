import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const macroRoutes = new Hono<{ Variables: Variables }>();

// GET /macro
// Phase 2 scope: cached-only. Upstream falls back to a live yfinance call
// (MacroConnector) when no successful report run has a macro_snapshot yet —
// that connector doesn't exist until Phase 3, so this returns a clean
// "no data yet" response instead of erroring or attempting a live fetch.
macroRoutes.get("/", requireUser, async (c) => {
  const { data: run, error } = await db
    .from("report_runs")
    .select("summary, run_date")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ detail: "Failed to load macro data" }, 500);

  const macroSnapshot = (run?.summary as Record<string, unknown> | undefined)?.macro;
  if (run && macroSnapshot) {
    return c.json({ source: "cached", run_date: run.run_date, data: macroSnapshot });
  }
  return c.json({ source: "empty", run_date: null, data: {} });
});

// GET /macro/sectors — real SQL LEFT JOIN + GROUP BY via macro_sector_breadth().
macroRoutes.get("/sectors", requireUser, async (c) => {
  const { data, error } = await db.rpc("macro_sector_breadth");
  if (error) return c.json({ detail: "Failed to load sector breadth" }, 500);
  return c.json(data || []);
});
