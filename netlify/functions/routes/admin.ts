import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireAdmin, type PublicUser } from "../lib/auth.js";
import { asNumber, loadSystemSettings, saveSystemSettings } from "../lib/settings.js";
import { discoverTelegramChats, getTelegramBotInfo, sendTelegram } from "../lib/delivery/telegram.js";
import { renderReportEmail, renderReportText, sendEmail } from "../lib/delivery/email.js";
import { expandUniverseFromKite } from "../lib/pipeline/universe.js";

type Variables = { user: PublicUser };
export const adminRoutes = new Hono<{ Variables: Variables }>();

adminRoutes.get("/settings", requireAdmin, async (c) => {
  return c.json(await loadSystemSettings());
});

adminRoutes.put("/settings", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(await saveSystemSettings(body));
});

adminRoutes.get("/scheduler", requireAdmin, async (c) => {
  const settings = await loadSystemSettings();
  const hour = Math.min(23, Math.max(0, asNumber(settings, "report_hour", 7)));
  const minute = Math.min(59, Math.max(0, asNumber(settings, "report_minute", 0)));
  const now = new Date();
  const next = new Date(now.getTime() + 5.5 * 3600 * 1000);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime() + 5.5 * 3600 * 1000) next.setUTCDate(next.getUTCDate() + 1);
  return c.json({ report_hour: hour, report_minute: minute, next_run: new Date(next.getTime() - 5.5 * 3600 * 1000).toISOString() });
});

adminRoutes.get("/deliveries", requireAdmin, async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || "100")));
  const { data, error } = await db
    .from("delivery_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load delivery logs" }, 500);
  return c.json(data || []);
});

adminRoutes.post("/test/telegram", requireAdmin, async (c) => {
  const body = (await c.req.json<{ chat_id?: string }>().catch(() => ({}))) as { chat_id?: string };
  const settings = await loadSystemSettings();
  const res = await sendTelegram(settings, String(body.chat_id || ""), "<b>Market Pulse India</b>\nTelegram delivery test.");
  return c.json({ ok: res.ok, status: res.status, error: res.error || null });
});

adminRoutes.post("/test/email", requireAdmin, async (c) => {
  const body = (await c.req.json<{ to?: string }>().catch(() => ({}))) as { to?: string };
  const settings = await loadSystemSettings();
  const ctx = { run_date: "test", narrative: "Email delivery test.", top_weekly: [], top_monthly: [] };
  const res = await sendEmail(settings, String(body.to || ""), "Market Pulse India - email test", renderReportEmail(ctx), renderReportText(ctx));
  return c.json({ ok: res.ok, status: res.status, error: res.error || null });
});

adminRoutes.post("/telegram/get-bot-info", requireAdmin, async (c) => {
  try {
    return c.json(await getTelegramBotInfo(await loadSystemSettings()));
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : "Bot verification failed" }, 400);
  }
});

adminRoutes.get("/telegram/discover", requireAdmin, async (c) => {
  try {
    const chats = await discoverTelegramChats(await loadSystemSettings());
    return c.json({ count: chats.length, chats });
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : "Discovery failed" }, 400);
  }
});

adminRoutes.post("/seed-full-universe", requireAdmin, async (c) => {
  try {
    const res = await expandUniverseFromKite();
    return c.json({ fetched: res.total, inserted: res.inserted, total: res.total });
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : "Universe refresh failed" }, 500);
  }
});
