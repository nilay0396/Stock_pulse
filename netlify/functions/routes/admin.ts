import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireAdmin, type PublicUser } from "../lib/auth.js";
import { asNumber, loadSystemSettings, publicSystemSettings, saveSystemSettings } from "../lib/settings.js";
import { discoverTelegramChats, getTelegramBotInfo, sendTelegram } from "../lib/delivery/telegram.js";
import { renderReportEmail, renderReportText, sendEmail } from "../lib/delivery/email.js";
import { expandUniverseFromKite } from "../lib/pipeline/universe.js";

type Variables = { user: PublicUser };
export const adminRoutes = new Hono<{ Variables: Variables }>();

type FreshnessSpec = {
  key: string;
  label: string;
  table: string;
  timestamp: string;
  category: "official" | "market" | "pipeline" | "delivery";
  required: boolean;
};

const FRESHNESS_SPECS: FreshnessSpec[] = [
  { key: "bhavcopy", label: "NSE delivery/bhavcopy", table: "bhavcopy_rows", timestamp: "ingested_at", category: "official", required: true },
  { key: "financial_results", label: "NSE/BSE results calendar", table: "financial_results", timestamp: "as_of", category: "official", required: true },
  { key: "corp_announcements", label: "Exchange announcements", table: "corp_announcements", timestamp: "ingested_at", category: "official", required: true },
  { key: "corp_actions", label: "Corporate actions", table: "corp_actions", timestamp: "ingested_at", category: "official", required: true },
  { key: "shareholding", label: "Shareholding filings", table: "shareholding_filings", timestamp: "ingested_at", category: "official", required: true },
  { key: "insider", label: "Insider/promoter trades", table: "insider_trades", timestamp: "ingested_at", category: "official", required: true },
  { key: "flows", label: "FII/DII flows", table: "fii_dii_flows", timestamp: "ingested_at", category: "official", required: true },
  { key: "technical_snapshots", label: "Technical snapshot cache", table: "technical_snapshots", timestamp: "as_of", category: "market", required: true },
  { key: "live_ticks", label: "Kite live ticks", table: "live_ticks", timestamp: "received_at", category: "market", required: false },
  { key: "report_runs", label: "Report runs", table: "report_runs", timestamp: "finished_at", category: "pipeline", required: true },
  { key: "delivery_logs", label: "Delivery logs", table: "delivery_logs", timestamp: "created_at", category: "delivery", required: true },
];

function ageMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
}

function freshnessStatus(spec: FreshnessSpec, latest: string | null, count: number): "fresh" | "stale" | "empty" | "optional_empty" | "error" {
  if (!count || !latest) return spec.required ? "empty" : "optional_empty";
  const age = ageMinutes(latest);
  if (age === null) return "error";
  if (spec.category === "market") return age <= 24 * 60 ? "fresh" : "stale";
  if (spec.category === "pipeline" || spec.category === "delivery") return age <= 36 * 60 ? "fresh" : "stale";
  return age <= 7 * 24 * 60 ? "fresh" : "stale";
}

async function dataFreshnessRow(spec: FreshnessSpec): Promise<Record<string, unknown>> {
  try {
    const { count, error: countError } = await db
      .from(spec.table)
      .select("*", { count: "exact", head: true });
    if (countError) throw countError;
    const { data, error } = await db
      .from(spec.table)
      .select(spec.timestamp)
      .not(spec.timestamp, "is", null)
      .order(spec.timestamp, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const latest = data ? String((data as unknown as Record<string, unknown>)[spec.timestamp] || "") : "";
    const rowCount = count || 0;
    return {
      ...spec,
      rows: rowCount,
      latest_at: latest || null,
      age_minutes: ageMinutes(latest || null),
      status: freshnessStatus(spec, latest || null, rowCount),
    };
  } catch (err) {
    return {
      ...spec,
      rows: 0,
      latest_at: null,
      age_minutes: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

adminRoutes.get("/settings", requireAdmin, async (c) => {
  return c.json(publicSystemSettings(await loadSystemSettings()));
});

adminRoutes.put("/settings", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(publicSystemSettings(await saveSystemSettings(body)));
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

adminRoutes.get("/data-freshness", requireAdmin, async (c) => {
  const rows = await Promise.all(FRESHNESS_SPECS.map(dataFreshnessRow));
  const required = rows.filter((r) => r.required);
  const degraded = required.filter((r) => !["fresh"].includes(String(r.status))).length;
  return c.json({
    as_of: new Date().toISOString(),
    status: degraded ? "degraded" : "fresh",
    degraded_required_sources: degraded,
    rows,
  });
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
