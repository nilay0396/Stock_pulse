import { Hono } from "hono";
import { db } from "../lib/db.js";

export const healthRoutes = new Hono();

healthRoutes.get("/health", async (c) => {
  return c.json({ status: "ok" });
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
