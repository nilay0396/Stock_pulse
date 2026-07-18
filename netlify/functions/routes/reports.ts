import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireAdmin, requireUser, type PublicUser } from "../lib/auth.js";
import { dispatchWorkflow, githubWorkflowConfig } from "../lib/githubWorkflow.js";

type Variables = { user: PublicUser };
export const reportsRoutes = new Hono<{ Variables: Variables }>();

// POST /reports/run
// Dispatches the long-running report pipeline through GitHub Actions. Running
// it in-process would exceed Netlify's normal function timeout.
reportsRoutes.post("/run", requireAdmin, async (c) => {
  const cfg = githubWorkflowConfig();
  if (!cfg.token) {
    return c.json({
      detail: "GitHub workflow dispatch is not configured. Add GITHUB_WORKFLOW_TOKEN in Netlify env vars.",
    }, 500);
  }

  const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
  const inputs = {
    skip_llm: String(Boolean(body.skip_llm ?? false)),
    universe_limit: String(body.universe_limit || ""),
    refresh_instruments: String(Boolean(body.refresh_instruments ?? true)),
    expand_universe: String(Boolean(body.expand_universe ?? true)),
    force: String(Boolean(body.force ?? true)),
    skip_delivery: String(Boolean(body.skip_delivery ?? false)),
  };

  try {
    await dispatchWorkflow(cfg, inputs);
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : "GitHub workflow dispatch failed" }, 502);
  }

  return c.json({
    status: "queued",
    provider: "github-actions",
    workflow: cfg.workflow,
    ref: cfg.ref,
    inputs,
  }, 202);
});

// GET /reports/history?limit=20
reportsRoutes.get("/history", requireUser, async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || "20")));
  const { data, error } = await db
    .from("report_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) return c.json({ detail: "Failed to load report history" }, 500);

  // Drop the heavy `summary.macro` payload from list views (kept on
  // /latest and /:runId, which return the full document).
  const rows = (data || []).map((row) => {
    if (row.summary && typeof row.summary === "object") {
      const { macro, ...rest } = row.summary as Record<string, unknown>;
      return { ...row, summary: rest };
    }
    return row;
  });
  return c.json(rows);
});

// GET /reports/latest
reportsRoutes.get("/latest", requireUser, async (c) => {
  const { data, error } = await db
    .from("report_runs")
    .select("*")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ detail: "Failed to load latest report" }, 500);
  if (!data) return c.json({ status: "empty" });
  return c.json(data);
});

// GET /reports/:runId
reportsRoutes.get("/:runId", requireUser, async (c) => {
  const runId = c.req.param("runId");

  const { data: run, error: runError } = await db
    .from("report_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (runError) return c.json({ detail: "Failed to load report" }, 500);
  if (!run) return c.json({ detail: "Report not found" }, 404);

  const { data: ideas, error: ideasError } = await db
    .from("trade_ideas")
    .select("*")
    .eq("report_run_id", runId)
    .limit(200);

  if (ideasError) return c.json({ detail: "Failed to load report ideas" }, 500);

  return c.json({ ...run, ideas: ideas || [] });
});

// GET /reports/:runId/funnel
reportsRoutes.get("/:runId/funnel", requireUser, async (c) => {
  const runId = c.req.param("runId");

  const { data: run, error } = await db
    .from("report_runs")
    .select("id, run_date, status, summary")
    .eq("id", runId)
    .maybeSingle();

  if (error) return c.json({ detail: "Failed to load report funnel" }, 500);
  if (!run) return c.json({ detail: "Report not found" }, 404);

  const summary = (run.summary as Record<string, unknown>) || {};
  // NOTE: the Python source reads a top-level `funnel` field with a
  // fallback to `summary.funnel` — our schema only ever populates
  // `summary.funnel` (matching the modeled ReportRun fields), so we read
  // that directly rather than carrying a redundant top-level column.
  const funnel = summary.funnel || {};
  const liteRankTop = Array.isArray(summary.lite_rank_top) ? summary.lite_rank_top.slice(0, 100) : [];

  return c.json({
    run_id: run.id,
    run_date: run.run_date ?? null,
    status: run.status ?? null,
    funnel,
    lite_rank_top: liteRankTop,
  });
});
