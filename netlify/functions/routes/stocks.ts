import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const stocksRoutes = new Hono<{ Variables: Variables }>();

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
