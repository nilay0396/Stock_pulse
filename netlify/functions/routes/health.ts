import { Hono } from "hono";
import { db } from "../lib/db.js";

export const healthRoutes = new Hono();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function calendarAgeDays(dateOnly?: string | null): number | null {
  if (!dateOnly) return null;
  const start = new Date(`${dateOnly}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return null;
  const now = new Date(`${todayIst()}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((now - start) / 86400000));
}

healthRoutes.get("/health", async (c) => {
  const { data: lastReport } = await db
    .from("report_runs")
    .select("id, run_date, started_at")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ageDays = calendarAgeDays(lastReport?.run_date);
  return c.json({
    status: "ok",
    today_ist: todayIst(),
    latest_successful_report: lastReport || null,
    latest_report_age_days: ageDays,
    report_stale: ageDays === null ? true : ageDays > 1,
  });
});

healthRoutes.get("/readiness", async (c) => {
  const { count: universeCount } = await db
    .from("stock_universe")
    .select("*", { count: "exact", head: true });

  // report_runs lands in Phase 2 — table may not exist yet, so this is
  // best-effort and degrades to null rather than 500ing (supabase-js
  // resolves with an `error` field on a missing-table query, it doesn't throw).
  const { data: lastReportRow } = await db
    .from("report_runs")
    .select("id, run_date")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastReport = lastReportRow || null;

  return c.json({
    status: "ready",
    universe_count: universeCount ?? 0,
    last_report: lastReport,
  });
});
