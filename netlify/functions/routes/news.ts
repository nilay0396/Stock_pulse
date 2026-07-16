import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const newsRoutes = new Hono<{ Variables: Variables }>();

// GET /news?symbol=&limit=50
newsRoutes.get("/", requireUser, async (c) => {
  const symbol = c.req.query("symbol");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || "50")));

  let query = db.from("news_items").select("*");
  if (symbol) query = query.eq("symbol", symbol.toUpperCase());

  const { data, error } = await query.order("ingested_at", { ascending: false }).limit(limit);
  if (error) return c.json({ detail: "Failed to load news" }, 500);
  return c.json(data || []);
});
