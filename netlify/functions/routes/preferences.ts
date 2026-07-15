import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireUser, type PublicUser } from "../lib/auth.js";

type Variables = { user: PublicUser };
export const preferencesRoutes = new Hono<{ Variables: Variables }>();

const DEFAULT_PREFS = {
  telegram_chat_id: "",
  email_alerts: true,
  telegram_alerts: true,
  delivery_time: "07:00",
  language: "en",
  preferred_sectors: [] as string[],
  horizon: "both",
  risk_appetite: "medium",
  watchlist: [] as string[],
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_PREFS));

preferencesRoutes.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const { data } = await db.from("user_preferences").select("*").eq("user_id", user.id).maybeSingle();
  if (!data) {
    return c.json({ ...DEFAULT_PREFS, user_id: user.id });
  }
  return c.json(data);
});

preferencesRoutes.put("/", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>();
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(k)) patch[k] = v;
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("user_preferences")
    .upsert({ user_id: user.id, ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) return c.json({ detail: "Failed to update preferences" }, 500);
  return c.json(data);
});
