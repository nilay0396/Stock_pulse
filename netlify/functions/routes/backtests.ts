import { Hono } from "hono";
import { db } from "../lib/db.js";
import { requireAdmin, requireUser, type PublicUser } from "../lib/auth.js";
import { fetchEquityOhlcDated, type DatedOhlcvBar } from "../lib/market/yahoo.js";

type Variables = { user: PublicUser };
export const backtestsRoutes = new Hono<{ Variables: Variables }>();

const HORIZON_DAYS: Record<string, number> = { weekly: 7, monthly: 30, both: 30 };
const ENTRY_WINDOW_DAYS = 3;
const PARTIAL_EXIT_PCT = 50;

type Idea = {
  id: string;
  report_run_id: string;
  symbol: string;
  name?: string | null;
  sector?: string | null;
  direction?: string | null;
  horizon?: string | null;
  conviction?: number | null;
  entry_low?: number | null;
  entry_high?: number | null;
  stop_loss?: number | null;
  target_low?: number | null;
  target_high?: number | null;
};

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function daysBetween(startDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return 370;
  return Math.max(45, Math.ceil((Date.now() - start) / 86400000) + 45);
}

function calendarDaysSince(dateOnly: string): number {
  const start = new Date(`${dateOnly}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.floor((Date.now() - start) / 86400000);
}

export function requiredDaysForIdea(idea: Pick<Idea, "horizon">): number {
  return ENTRY_WINDOW_DAYS + (HORIZON_DAYS[idea.horizon || "weekly"] || 7) + 2;
}

function readyDate(runDate: string, requiredDays: number): string | null {
  const start = new Date(`${runDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + requiredDays * 86400000).toISOString().slice(0, 10);
}

function signedReturnPct(direction: string, entry: number, exit: number): number {
  if (!entry) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return Number((direction === "bearish" ? -raw : raw).toFixed(3));
}

function outcome(
  idea: Idea,
  outcomeName: string,
  entryPrice: number,
  exitPrice: number,
  holdingDays: number,
  entryDate: string,
  exitDate: string,
  extra: Record<string, unknown> = {},
) {
  const direction = idea.direction || "bullish";
  return {
    outcome: outcomeName,
    entry_price: Number(entryPrice.toFixed(2)),
    exit_price: Number(exitPrice.toFixed(2)),
    holding_days: holdingDays,
    return_pct: signedReturnPct(direction, entryPrice, exitPrice),
    entry_date: entryDate,
    exit_date: exitDate,
    ...extra,
  };
}

function blendedReturnPct(direction: string, entry: number, target1: number, exit: number): number {
  const partial = PARTIAL_EXIT_PCT / 100;
  const firstLeg = signedReturnPct(direction, entry, target1);
  const secondLeg = signedReturnPct(direction, entry, exit);
  return Number((firstLeg * partial + secondLeg * (1 - partial)).toFixed(3));
}

export function simulateTrade(bars: DatedOhlcvBar[], idea: Idea) {
  const direction = idea.direction || "bullish";
  const entryLow = asNumber(idea.entry_low);
  const entryHigh = asNumber(idea.entry_high);
  const stopLoss = asNumber(idea.stop_loss);
  const targetLow = asNumber(idea.target_low);
  const targetHigh = asNumber(idea.target_high);
  const horizonDays = HORIZON_DAYS[idea.horizon || "weekly"] || 7;

  if (!bars.length || !entryLow || !entryHigh || !stopLoss || !targetLow || !targetHigh) {
    return { outcome: "no_data" };
  }

  let entryIndex = -1;
  let entryPrice = 0;
  for (let i = 0; i < Math.min(ENTRY_WINDOW_DAYS, bars.length); i += 1) {
    const bar = bars[i];
    if (bar.low <= entryHigh && bar.high >= entryLow) {
      entryIndex = i;
      const open = bar.open ?? bar.close;
      entryPrice = open >= entryLow && open <= entryHigh ? open : (entryLow + entryHigh) / 2;
      break;
    }
  }

  if (entryIndex < 0 || !entryPrice) return { outcome: "no_entry" };

  const endIndex = Math.min(bars.length - 1, entryIndex + horizonDays);
  const entryDate = bars[entryIndex].date;
  const target1 = direction === "bearish" ? targetHigh : targetLow;
  const target2 = direction === "bearish" ? targetLow : targetHigh;
  let target1Date: string | null = null;
  let target1Price = 0;
  let trailingStop = entryPrice;

  for (let i = entryIndex + 1; i <= endIndex; i += 1) {
    const bar = bars[i];
    if (direction === "bearish") {
      let hitTarget1ThisBar = false;
      if (!target1Date && bar.high >= stopLoss) return outcome(idea, "hit_stop", entryPrice, stopLoss, i - entryIndex, entryDate, bar.date);
      if (!target1Date && bar.low <= target1) {
        target1Date = bar.date;
        target1Price = target1;
        trailingStop = entryPrice;
        hitTarget1ThisBar = true;
      }
      if (target1Date) {
        if (bar.low <= target2) {
          const res = outcome(idea, "hit_target", entryPrice, target2, i - entryIndex, entryDate, bar.date, {
            target1_date: target1Date,
            target1_price: Number(target1Price.toFixed(2)),
            partial_exit_pct: PARTIAL_EXIT_PCT,
            trailing_stop: Number(trailingStop.toFixed(2)),
          });
          res.return_pct = blendedReturnPct(direction, entryPrice, target1Price, target2);
          return res;
        }
        if (!hitTarget1ThisBar && bar.high >= trailingStop) {
          const res = outcome(idea, "hit_trailing_stop", entryPrice, trailingStop, i - entryIndex, entryDate, bar.date, {
            target1_date: target1Date,
            target1_price: Number(target1Price.toFixed(2)),
            partial_exit_pct: PARTIAL_EXIT_PCT,
            trailing_stop: Number(trailingStop.toFixed(2)),
          });
          res.return_pct = blendedReturnPct(direction, entryPrice, target1Price, trailingStop);
          return res;
        }
        if (!hitTarget1ThisBar) trailingStop = Math.min(trailingStop, bar.close * 1.025);
      }
    } else {
      let hitTarget1ThisBar = false;
      if (!target1Date && bar.low <= stopLoss) return outcome(idea, "hit_stop", entryPrice, stopLoss, i - entryIndex, entryDate, bar.date);
      if (!target1Date && bar.high >= target1) {
        target1Date = bar.date;
        target1Price = target1;
        trailingStop = entryPrice;
        hitTarget1ThisBar = true;
      }
      if (target1Date) {
        if (bar.high >= target2) {
          const res = outcome(idea, "hit_target", entryPrice, target2, i - entryIndex, entryDate, bar.date, {
            target1_date: target1Date,
            target1_price: Number(target1Price.toFixed(2)),
            partial_exit_pct: PARTIAL_EXIT_PCT,
            trailing_stop: Number(trailingStop.toFixed(2)),
          });
          res.return_pct = blendedReturnPct(direction, entryPrice, target1Price, target2);
          return res;
        }
        if (!hitTarget1ThisBar && bar.low <= trailingStop) {
          const res = outcome(idea, "hit_trailing_stop", entryPrice, trailingStop, i - entryIndex, entryDate, bar.date, {
            target1_date: target1Date,
            target1_price: Number(target1Price.toFixed(2)),
            partial_exit_pct: PARTIAL_EXIT_PCT,
            trailing_stop: Number(trailingStop.toFixed(2)),
          });
          res.return_pct = blendedReturnPct(direction, entryPrice, target1Price, trailingStop);
          return res;
        }
        if (!hitTarget1ThisBar) trailingStop = Math.max(trailingStop, bar.close * 0.975);
      }
    }
  }

  const last = bars[endIndex];
  const res = outcome(idea, target1Date ? "target_1_hit" : "time_stop", entryPrice, last.close, endIndex - entryIndex, entryDate, last.date, target1Date ? {
    target1_date: target1Date,
    target1_price: Number(target1Price.toFixed(2)),
    partial_exit_pct: PARTIAL_EXIT_PCT,
    trailing_stop: Number(trailingStop.toFixed(2)),
  } : {});
  if (target1Date) res.return_pct = blendedReturnPct(direction, entryPrice, target1Price, last.close);
  return res;
}

function summarize(trades: Record<string, unknown>[]) {
  const closed = trades.filter((t) => ["hit_target", "hit_stop", "hit_trailing_stop", "target_1_hit", "time_stop"].includes(String(t.outcome)));
  const wins = closed.filter((t) => Number(t.return_pct || 0) > 0);
  const targets = closed.filter((t) => t.outcome === "hit_target");
  const target1 = closed.filter((t) => t.outcome === "target_1_hit");
  const stops = closed.filter((t) => t.outcome === "hit_stop" || t.outcome === "hit_trailing_stop");
  const noEntry = trades.filter((t) => t.outcome === "no_entry");
  const noData = trades.filter((t) => t.outcome === "no_data" || t.outcome === "error");
  const avg = (key: string) => closed.length ? closed.reduce((s, t) => s + Number(t[key] || 0), 0) / closed.length : 0;

  const byHorizon: Record<string, unknown> = {};
  for (const horizon of ["weekly", "monthly"]) {
    const sub = closed.filter((t) => t.horizon === horizon);
    if (sub.length) {
      const subWins = sub.filter((t) => Number(t.return_pct || 0) > 0);
      byHorizon[horizon] = {
        count: sub.length,
        hit_rate_pct: Number(((subWins.length / sub.length) * 100).toFixed(2)),
        avg_return_pct: Number((sub.reduce((s, t) => s + Number(t.return_pct || 0), 0) / sub.length).toFixed(3)),
      };
    }
  }

  return {
    total: trades.length,
    closed: closed.length,
    no_entry: noEntry.length,
    no_data: noData.length,
    targets: targets.length,
    target_1_hits: target1.length,
    stops: stops.length,
    hit_rate_pct: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    target_rate_pct: closed.length ? Number(((targets.length / closed.length) * 100).toFixed(2)) : 0,
    avg_return_pct: Number(avg("return_pct").toFixed(3)),
    avg_holding_days: Number(avg("holding_days").toFixed(2)),
    by_horizon: byHorizon,
  };
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    const i = cursor;
    cursor += 1;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

async function runOneIdea(idea: Idea, runDate: string) {
  try {
    const rawBars = await fetchEquityOhlcDated(idea.symbol, daysBetween(runDate));
    const bars = rawBars.filter((bar) => bar.date > runDate);
    const sim = simulateTrade(bars, idea);
    return {
      trade_idea_id: idea.id,
      symbol: idea.symbol,
      name: idea.name,
      sector: idea.sector,
      direction: idea.direction,
      horizon: idea.horizon,
      conviction: idea.conviction,
      entry_low: idea.entry_low,
      entry_high: idea.entry_high,
      stop_loss: idea.stop_loss,
      target_low: idea.target_low,
      target_high: idea.target_high,
      ...sim,
    };
  } catch (err) {
    return {
      trade_idea_id: idea.id,
      symbol: idea.symbol,
      name: idea.name,
      sector: idea.sector,
      direction: idea.direction,
      horizon: idea.horizon,
      conviction: idea.conviction,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function nullableNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function backtestTradeRow(trade: Record<string, unknown>, backtestRunId: string, reportRunId: string) {
  return {
    backtest_run_id: backtestRunId,
    report_run_id: reportRunId,
    trade_idea_id: nullableText(trade.trade_idea_id),
    symbol: String(trade.symbol || ""),
    name: nullableText(trade.name),
    sector: nullableText(trade.sector),
    direction: nullableText(trade.direction),
    horizon: nullableText(trade.horizon),
    conviction: nullableNumber(trade.conviction),
    entry_low: nullableNumber(trade.entry_low),
    entry_high: nullableNumber(trade.entry_high),
    stop_loss: nullableNumber(trade.stop_loss),
    target_low: nullableNumber(trade.target_low),
    target_high: nullableNumber(trade.target_high),
    entry_date: nullableText(trade.entry_date),
    exit_date: nullableText(trade.exit_date),
    entry_price: nullableNumber(trade.entry_price),
    exit_price: nullableNumber(trade.exit_price),
    holding_days: nullableInteger(trade.holding_days),
    return_pct: nullableNumber(trade.return_pct),
    outcome: String(trade.outcome || "error"),
    target1_date: nullableText(trade.target1_date),
    target1_price: nullableNumber(trade.target1_price),
    trailing_stop: nullableNumber(trade.trailing_stop),
    partial_exit_pct: nullableNumber(trade.partial_exit_pct) ?? PARTIAL_EXIT_PCT,
    error: nullableText(trade.error),
  };
}

backtestsRoutes.get("/runs", requireUser, async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || "50")));
  const { data, error } = await db
    .from("backtest_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load backtests" }, 500);
  return c.json(data || []);
});

backtestsRoutes.get("/candidates", requireUser, async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || "60")));
  const { data: reports, error } = await db
    .from("report_runs")
    .select("id,run_date,started_at,status")
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ detail: "Failed to load backtest candidates" }, 500);

  const reportIds = (reports || []).map((r) => r.id);
  const { data: ideas, error: ideasError } = reportIds.length
    ? await db.from("trade_ideas").select("id,report_run_id,horizon,symbol").in("report_run_id", reportIds).limit(1000)
    : { data: [], error: null };
  if (ideasError) return c.json({ detail: "Failed to load backtest idea counts" }, 500);

  const byReport = new Map<string, Idea[]>();
  for (const idea of ideas || []) {
    const bucket = byReport.get(idea.report_run_id) || [];
    bucket.push(idea as Idea);
    byReport.set(idea.report_run_id, bucket);
  }

  return c.json((reports || []).map((report) => {
    const runIdeas = byReport.get(report.id) || [];
    const availableDays = calendarDaysSince(report.run_date);
    const matureIdeas = runIdeas.filter((idea) => availableDays >= requiredDaysForIdea(idea));
    const requiredDays = runIdeas.length ? Math.min(...runIdeas.map(requiredDaysForIdea)) : null;
    const nextRequiredDays = runIdeas
      .map(requiredDaysForIdea)
      .filter((days) => availableDays < days)
      .sort((a, b) => a - b)[0] ?? null;
    return {
      ...report,
      idea_count: runIdeas.length,
      mature_idea_count: matureIdeas.length,
      pending_idea_count: runIdeas.length - matureIdeas.length,
      available_days: availableDays,
      required_days: requiredDays,
      ready: matureIdeas.length > 0,
      ready_on: requiredDays === null ? null : readyDate(report.run_date, requiredDays),
      next_ready_on: nextRequiredDays === null ? null : readyDate(report.run_date, nextRequiredDays),
      horizons: [...new Set(runIdeas.map((idea) => idea.horizon).filter(Boolean))],
      symbols: runIdeas.slice(0, 8).map((idea) => idea.symbol),
    };
  }));
});

backtestsRoutes.get("/runs/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const { data: run, error } = await db.from("backtest_runs").select("*").eq("id", id).maybeSingle();
  if (error) return c.json({ detail: "Failed to load backtest" }, 500);
  if (!run) return c.json({ detail: "Backtest not found" }, 404);
  const { data: trades, error: tradeError } = await db
    .from("backtest_trades")
    .select("*")
    .eq("backtest_run_id", id)
    .order("return_pct", { ascending: false, nullsFirst: false })
    .limit(500);
  if (tradeError) return c.json({ detail: "Failed to load backtest trades" }, 500);
  return c.json({ ...run, trades: trades || [] });
});

backtestsRoutes.post("/run/:reportRunId", requireAdmin, async (c) => {
  const reportRunId = String(c.req.param("reportRunId") || "");
  const user = c.get("user");
  const { data: report, error: reportError } = await db
    .from("report_runs")
    .select("id,run_date")
    .eq("id", reportRunId)
    .maybeSingle();
  if (reportError) return c.json({ detail: "Failed to load report run" }, 500);
  if (!report) return c.json({ detail: "Report run not found" }, 404);

  const { data: ideas, error: ideasError } = await db
    .from("trade_ideas")
    .select("*")
    .eq("report_run_id", reportRunId)
    .limit(200);
  if (ideasError) return c.json({ detail: "Failed to load report ideas" }, 500);
  if (!ideas?.length) {
    return c.json({
      detail: `This report has no generated trade ideas to backtest.`,
      run_date: report.run_date,
      ideas_total: 0,
      mature_ideas: 0,
    }, 409);
  }

  const ageDays = calendarDaysSince(report.run_date);
  const matureIdeas = (ideas || []).filter((idea) => ageDays >= requiredDaysForIdea(idea));
  if (!matureIdeas.length) {
    const nextRequiredDays = Math.min(...(ideas || []).map(requiredDaysForIdea));
    return c.json({
      detail: `Too early to backtest this report. The first ideas from ${report.run_date} are ready on ${readyDate(report.run_date, nextRequiredDays)}.`,
      run_date: report.run_date,
      required_days: nextRequiredDays,
      available_days: ageDays,
      ideas_total: ideas.length,
      mature_ideas: 0,
      pending_ideas: ideas.length,
      ready_on: readyDate(report.run_date, nextRequiredDays),
    }, 409);
  }

  const created = await db
    .from("backtest_runs")
    .insert({
      report_run_id: reportRunId,
      run_date: report.run_date,
      status: "running",
      triggered_by: user.email,
      trades_count: matureIdeas.length,
      summary: {
        ideas_total: ideas.length,
        mature_ideas: matureIdeas.length,
        pending_ideas: ideas.length - matureIdeas.length,
        available_days: ageDays,
      },
    })
    .select("*")
    .single();
  if (created.error || !created.data) return c.json({ detail: "Failed to create backtest run" }, 500);
  const backtestId = String(created.data.id);

  const trades = await runPool(matureIdeas as Idea[], 6, (idea) => runOneIdea(idea, report.run_date));
  const rows = trades.map((trade) => backtestTradeRow(trade, backtestId, reportRunId));
  if (rows.length) {
    const { error: insertError } = await db.from("backtest_trades").insert(rows);
    if (insertError) {
      console.error("Failed to save backtest trades", {
        reportRunId,
        backtestId,
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        outcomes: rows.map((row) => row.outcome),
      });
      await db.from("backtest_runs").update({
        status: "failed",
        error: [insertError.message, insertError.details, insertError.hint].filter(Boolean).join(" | "),
        finished_at: new Date().toISOString(),
      }).eq("id", backtestId);
      return c.json({
        detail: "Failed to save backtest trades",
        error: insertError.message,
        code: insertError.code,
      }, 500);
    }
  }

  const summary = {
    ...summarize(rows),
    ideas_total: ideas.length,
    mature_ideas: matureIdeas.length,
    pending_ideas: ideas.length - matureIdeas.length,
    available_days: ageDays,
  };
  const { data: updated } = await db
    .from("backtest_runs")
    .update({
      status: "success",
      summary,
      trades_count: rows.length,
      finished_at: new Date().toISOString(),
    })
    .eq("id", backtestId)
    .select("*")
    .single();

  return c.json({ ...(updated || created.data), summary, trades: rows });
});
