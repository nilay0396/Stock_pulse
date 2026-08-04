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

function countBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    out[value] = (out[value] || 0) + 1;
  }
  return out;
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

healthRoutes.get("/health/reports", async (c) => {
  const { data: reports, error: reportError } = await db
    .from("report_runs")
    .select("id, run_date, status, started_at, finished_at, error, summary")
    .order("started_at", { ascending: false })
    .limit(7);

  if (reportError) return c.json({ status: "error", detail: "Failed to load report diagnostics" }, 500);

  const reportIds = (reports || []).map((report) => report.id).filter(Boolean);
  const { data: ideas } = reportIds.length
    ? await db.from("trade_ideas").select("id, report_run_id").in("report_run_id", reportIds)
    : { data: [] };
  const { data: deliveries } = reportIds.length
    ? await db.from("delivery_logs").select("report_run_id, channel, status").in("report_run_id", reportIds)
    : { data: [] };

  const ideasByReport = countBy(ideas || [], "report_run_id");
  const deliveriesByReport = new Map<string, { total: number; by_status: Record<string, number>; by_channel: Record<string, number> }>();
  for (const row of deliveries || []) {
    const reportId = String(row.report_run_id || "");
    const bucket = deliveriesByReport.get(reportId) || { total: 0, by_status: {}, by_channel: {} };
    bucket.total += 1;
    const status = String(row.status || "unknown");
    const channel = String(row.channel || "unknown");
    bucket.by_status[status] = (bucket.by_status[status] || 0) + 1;
    bucket.by_channel[channel] = (bucket.by_channel[channel] || 0) + 1;
    deliveriesByReport.set(reportId, bucket);
  }

  return c.json({
    status: "ok",
    today_ist: todayIst(),
    reports: (reports || []).map((report) => {
      const summary = (report.summary || {}) as Record<string, unknown>;
      const funnel = (summary.funnel || {}) as Record<string, unknown>;
      return {
        id: report.id,
        run_date: report.run_date,
        status: report.status,
        started_at: report.started_at,
        finished_at: report.finished_at,
        age_days: calendarAgeDays(report.run_date),
        error: report.error || null,
        idea_rows: ideasByReport[String(report.id)] || 0,
        top_weekly: Array.isArray(summary.top_weekly) ? summary.top_weekly.length : 0,
        top_monthly: Array.isArray(summary.top_monthly) ? summary.top_monthly.length : 0,
        excluded_by_earnings: Array.isArray(summary.excluded_by_earnings) ? summary.excluded_by_earnings.length : Number(summary.excluded_by_earnings || 0),
        funnel: {
          universe: Number(funnel.universe || 0),
          scored: Number(funnel.scored || 0),
          weekly_candidates: Number(funnel.weekly_candidates || 0),
          monthly_candidates: Number(funnel.monthly_candidates || 0),
          excluded_by_earnings: Number(funnel.excluded_by_earnings || 0),
          ai_rejected_ideas: Number(funnel.ai_rejected_ideas || 0),
          reason: String(funnel.reason || ""),
        },
        delivery: deliveriesByReport.get(String(report.id)) || { total: 0, by_status: {}, by_channel: {} },
      };
    }),
  });
});

healthRoutes.get("/health/explorer", async (c) => {
  const { count: universeCount, error: universeError } = await db
    .from("stock_universe")
    .select("*", { count: "exact", head: true });
  if (universeError) return c.json({ status: "error", detail: "Failed to load explorer universe diagnostics" }, 500);

  const [{ count: otherCount }, { count: unknownIndustryCount }, { count: technicalCount }] = await Promise.all([
    db.from("stock_universe").select("*", { count: "exact", head: true }).eq("sector", "Other"),
    db.from("stock_universe").select("*", { count: "exact", head: true }).eq("industry", "Unknown"),
    db.from("technical_snapshots").select("*", { count: "exact", head: true }),
  ]);

  const { data: latestReport } = await db
    .from("report_runs")
    .select("id, run_date, started_at, status")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: latestScoreCount } = latestReport?.id
    ? await db.from("stock_scores").select("*", { count: "exact", head: true }).eq("report_run_id", latestReport.id)
    : { count: 0 };

  const { data: scoreRows } = latestReport?.id
    ? await db
      .from("stock_scores")
      .select("symbol,sector,direction,conviction,technical,fundamental,macro_sector,data_confidence_score")
      .eq("report_run_id", latestReport.id)
      .order("conviction", { ascending: false })
      .limit(25)
    : { data: [] };

  const { data: sectorRows } = await db
    .from("stock_universe")
    .select("sector")
    .limit(5000);
  const sectorCounts = countBy(sectorRows || [], "sector");

  const { data: technicalRows } = await db
    .from("technical_snapshots")
    .select("as_of")
    .order("as_of", { ascending: false })
    .limit(1);

  const scoredCoveragePct = universeCount ? Math.round(((latestScoreCount || 0) / universeCount) * 10000) / 100 : 0;
  return c.json({
    status: "ok",
    today_ist: todayIst(),
    universe: {
      total: universeCount || 0,
      sector_other: otherCount || 0,
      industry_unknown: unknownIndustryCount || 0,
      sector_counts: Object.fromEntries(Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)),
      source: "stock_universe populated from Kite NSE EQ cache plus curated seed rows",
      known_scope: "NSE EQ symbols only; excludes ETFs, REITs/InvITs, debt/gilt products and several non-ordinary series.",
    },
    latest_report: latestReport || null,
    explorer_table: {
      endpoint: "/ideas/scores",
      frontend_requested_limit: 500,
      backend_max_limit: 500,
      latest_scored_rows: latestScoreCount || 0,
      scored_coverage_pct: scoredCoveragePct,
      top_rows: scoreRows || [],
    },
    technical_snapshots: {
      total: technicalCount || 0,
      latest_as_of: technicalRows?.[0]?.as_of || null,
    },
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
