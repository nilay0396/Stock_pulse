import type { Handler } from "@netlify/functions";
import { db } from "./lib/db.js";
import { sendOpsAlert } from "./lib/delivery/opsAlert.js";
import { dispatchWorkflow, githubWorkflowConfig, listRecentWorkflowRuns } from "./lib/githubWorkflow.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function json(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function slotHour(raw: string | undefined, now = new Date()): 9 | 13 {
  if (raw === "9" || raw === "09") return 9;
  if (raw === "13") return 13;

  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() < 13 ? 9 : 13;
}

function slotStartUtc(hour: 9 | 13, now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    hour,
    0,
    0,
    0,
  ) - IST_OFFSET_MS);
}

function istDateKey(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

function isAuthorized(headers: Record<string, string | undefined>, query: Record<string, string | undefined>): boolean {
  const expected = process.env.REPORT_BACKUP_SECRET || "";
  if (!expected) return false;
  const supplied = headers["x-scheduler-secret"] || headers["x-backup-secret"] || query.secret || "";
  return supplied.length > 0 && supplied === expected;
}

async function successfulReportExistsSince(since: Date): Promise<string | null> {
  const { data, error } = await db
    .from("report_runs")
    .select("id")
    .eq("status", "success")
    .gte("started_at", since.toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Supabase report lookup failed: ${error.message}`);
  return data?.id || null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { detail: "Method not allowed" });
  }

  if (!isAuthorized(event.headers as Record<string, string | undefined>, event.queryStringParameters || {})) {
    return json(401, { detail: "Unauthorized" });
  }

  const cfg = githubWorkflowConfig();
  if (!cfg.token) {
    await sendOpsAlert("Backup scheduler misconfigured", "GITHUB_WORKFLOW_TOKEN is missing in Netlify env vars.");
    return json(500, { detail: "GitHub workflow dispatch is not configured. Add GITHUB_WORKFLOW_TOKEN in Netlify env vars." });
  }

  const now = new Date();
  const slot = slotHour(event.queryStringParameters?.slot, now);
  const slotStart = slotStartUtc(slot, now);
  const slotLabel = `${istDateKey(slotStart)} ${String(slot).padStart(2, "0")}:00 IST`;
  const dryRun = event.queryStringParameters?.dry_run === "true";

  try {
    const existingReportId = await successfulReportExistsSince(slotStart);
    if (existingReportId) {
      return json(200, {
        status: "skipped",
        reason: "report_already_successful_for_slot",
        slot: slotLabel,
        report_run_id: existingReportId,
      });
    }

    const recentRuns = await listRecentWorkflowRuns(cfg, 20);
    const activeRun = recentRuns.find((run) => {
      const createdAt = new Date(run.created_at);
      if (createdAt < slotStart) return false;
      if (run.event !== "schedule" && run.event !== "workflow_dispatch") return false;
      if (run.status !== "completed") return true;
      return run.conclusion === "success";
    });

    if (activeRun) {
      return json(200, {
        status: "skipped",
        reason: activeRun.status === "completed" ? "github_run_already_completed_for_slot" : "github_run_already_active_for_slot",
        slot: slotLabel,
        github_run: {
          id: activeRun.id,
          event: activeRun.event,
          status: activeRun.status,
          conclusion: activeRun.conclusion,
          created_at: activeRun.created_at,
          html_url: activeRun.html_url,
        },
      });
    }

    const inputs = {
      skip_llm: "false",
      universe_limit: "",
      refresh_instruments: "true",
      expand_universe: "true",
      force: "true",
      skip_delivery: "false",
    };

    if (!dryRun) await dispatchWorkflow(cfg, inputs);

    return json(dryRun ? 200 : 202, {
      status: dryRun ? "would_queue" : "queued",
      provider: "github-actions",
      workflow: cfg.workflow,
      ref: cfg.ref,
      slot: slotLabel,
      inputs,
    });
  } catch (err) {
    console.error("report-scheduler-backup failed", err);
    await sendOpsAlert("Backup scheduler failed", err instanceof Error ? err.stack || err.message : String(err));
    return json(500, { detail: err instanceof Error ? err.message : "Backup scheduler failed" });
  }
};
