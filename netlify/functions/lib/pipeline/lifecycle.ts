import { db } from "../db.js";
import { fetchEquityOhlcDated, type DatedOhlcvBar } from "../market/yahoo.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

const HORIZON_DAYS: Record<string, number> = { weekly: 7, monthly: 30, both: 30 };
const FINAL_STATUSES = new Set(["hit_target", "hit_stop", "expired", "no_entry", "no_data", "error"]);
const FINAL_STATUS_FILTER = '("hit_target","hit_stop","expired","no_entry","no_data","error")';

type LifecycleRow = {
  id: string;
  trade_idea_id: string;
  report_run_id: string;
  original_run_date: string;
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
  status: string;
  current_price?: number | null;
  entry_date?: string | null;
  entry_price?: number | null;
  exit_date?: string | null;
  exit_price?: number | null;
  return_pct?: number | null;
  days_active?: number | null;
  status_note?: string | null;
  ai_followup?: string | null;
};

function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function calendarDaysSince(dateOnly: string, now = new Date()): number {
  const start = new Date(`${dateOnly}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / 86400000));
}

function signedReturnPct(direction: string, entry: number, exit: number): number {
  if (!entry || !exit) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return round(direction === "bearish" ? -raw : raw, 3);
}

function enteredOnBar(bar: DatedOhlcvBar, entryLow: number, entryHigh: number): boolean {
  return bar.low <= entryHigh && bar.high >= entryLow;
}

function entryPriceForBar(bar: DatedOhlcvBar, entryLow: number, entryHigh: number): number {
  const open = bar.open ?? bar.close;
  return open >= entryLow && open <= entryHigh ? open : (entryLow + entryHigh) / 2;
}

function followupText(row: LifecycleRow): string {
  const sym = row.symbol;
  const pct = row.return_pct !== null && row.return_pct !== undefined ? `${row.return_pct > 0 ? "+" : ""}${row.return_pct}%` : "flat";
  if (row.status === "hit_target") return `${sym} hit target. Book outcome; thesis completed with ${pct}.`;
  if (row.status === "hit_stop") return `${sym} hit stop-loss. Close the idea; risk control triggered at ${pct}.`;
  if (row.status === "expired") return `${sym} expired by time. Review rather than extend automatically; last tracked return was ${pct}.`;
  if (row.status === "no_entry") return `${sym} never entered the suggested range before expiry. No trade taken.`;
  if (row.status === "active") return `${sym} remains active. Hold the original plan unless fresh news invalidates the setup; tracked return is ${pct}.`;
  if (row.status === "pending_entry") return `${sym} has not entered yet. Keep it on watch until the ${row.horizon || "planned"} window expires.`;
  if (row.status === "no_data") return `${sym} could not be reviewed because forward price data is unavailable.`;
  return `${sym} follow-up needs manual review.`;
}

function evaluateLifecycle(row: LifecycleRow, bars: DatedOhlcvBar[], now = new Date()): LifecycleRow {
  const direction = row.direction || "bullish";
  const entryLow = asNumber(row.entry_low);
  const entryHigh = asNumber(row.entry_high);
  const stopLoss = asNumber(row.stop_loss);
  const targetLow = asNumber(row.target_low);
  const targetHigh = asNumber(row.target_high);
  const horizonDays = HORIZON_DAYS[row.horizon || "weekly"] || 7;
  const elapsedDays = calendarDaysSince(row.original_run_date, now);

  if (!entryLow || !entryHigh || !stopLoss || !targetLow || !targetHigh) {
    return { ...row, status: "no_data", status_note: "Missing entry, stop or target levels", days_active: elapsedDays };
  }

  if (!bars.length) {
    return {
      ...row,
      status: elapsedDays > horizonDays ? "no_data" : row.status || "pending_entry",
      status_note: "No forward OHLC data available yet",
      days_active: elapsedDays,
    };
  }

  let status = row.status || "pending_entry";
  let entryDate = row.entry_date || null;
  let entryPrice = asNumber(row.entry_price);
  let exitDate = row.exit_date || null;
  let exitPrice = asNumber(row.exit_price);
  let currentPrice = bars[bars.length - 1].close;

  for (const bar of bars) {
    currentPrice = bar.close;
    if (!entryDate && enteredOnBar(bar, entryLow, entryHigh)) {
      entryDate = bar.date;
      entryPrice = entryPriceForBar(bar, entryLow, entryHigh);
      status = "active";
    }

    if (!entryDate) continue;

    if (direction === "bearish") {
      if (bar.high >= stopLoss) {
        status = "hit_stop";
        exitDate = bar.date;
        exitPrice = stopLoss;
        break;
      }
      if (bar.low <= targetHigh) {
        status = "hit_target";
        exitDate = bar.date;
        exitPrice = targetHigh;
        break;
      }
    } else {
      if (bar.low <= stopLoss) {
        status = "hit_stop";
        exitDate = bar.date;
        exitPrice = stopLoss;
        break;
      }
      if (bar.high >= targetLow) {
        status = "hit_target";
        exitDate = bar.date;
        exitPrice = targetLow;
        break;
      }
    }
  }

  if (!FINAL_STATUSES.has(status) && elapsedDays >= horizonDays) {
    if (!entryDate) {
      status = "no_entry";
      exitDate = bars[bars.length - 1].date;
      exitPrice = currentPrice;
    } else {
      status = "expired";
      exitDate = bars[bars.length - 1].date;
      exitPrice = currentPrice;
    }
  }

  const markPrice = exitPrice || currentPrice;
  const returnPct = entryDate && entryPrice ? signedReturnPct(direction, entryPrice, markPrice) : null;
  const next: LifecycleRow = {
    ...row,
    status,
    current_price: round(currentPrice, 2),
    entry_date: entryDate,
    entry_price: entryPrice ? round(entryPrice, 2) : null,
    exit_date: exitDate,
    exit_price: exitPrice ? round(exitPrice, 2) : null,
    return_pct: returnPct,
    days_active: elapsedDays,
    status_note: status.replace(/_/g, " "),
  };
  next.ai_followup = followupText(next);
  return next;
}

async function seedMissingLifecycleRows(): Promise<void> {
  const { data: ideas, error } = await db
    .from("trade_ideas")
    .select("*, report_runs!inner(run_date)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    console.warn("lifecycle seed warning:", error.message);
    return;
  }

  const rows = (ideas || []).map((idea) => ({
    trade_idea_id: idea.id,
    report_run_id: idea.report_run_id,
    original_run_date: idea.report_runs?.run_date || String(idea.created_at || "").slice(0, 10),
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
    status: "pending_entry",
  }));

  if (!rows.length) return;
  const { error: upsertError } = await db.from("recommendation_lifecycle").upsert(rows, { onConflict: "trade_idea_id", ignoreDuplicates: true });
  if (upsertError) console.warn("lifecycle seed upsert warning:", upsertError.message);
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

async function updateOne(row: LifecycleRow): Promise<LifecycleRow> {
  try {
    const days = Math.max(45, calendarDaysSince(row.original_run_date) + 10);
    const rawBars = await fetchEquityOhlcDated(row.symbol, days);
    const bars = rawBars.filter((bar) => bar.date > row.original_run_date);
    const next = evaluateLifecycle(row, bars);
    const { error } = await db
      .from("recommendation_lifecycle")
      .update({
        status: next.status,
        current_price: next.current_price ?? null,
        entry_date: next.entry_date ?? null,
        entry_price: next.entry_price ?? null,
        exit_date: next.exit_date ?? null,
        exit_price: next.exit_price ?? null,
        return_pct: next.return_pct ?? null,
        days_active: next.days_active ?? 0,
        last_checked_at: new Date().toISOString(),
        status_note: next.status_note ?? null,
        ai_followup: next.ai_followup ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw error;
    return next;
  } catch (err) {
    const next = {
      ...row,
      status: "error",
      status_note: err instanceof Error ? err.message : String(err),
      ai_followup: `${row.symbol} follow-up failed because price data could not be evaluated.`,
    };
    await db
      .from("recommendation_lifecycle")
      .update({
        status: next.status,
        status_note: next.status_note,
        ai_followup: next.ai_followup,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return next;
  }
}

function compact(row: LifecycleRow): Dict {
  return {
    trade_idea_id: row.trade_idea_id,
    report_run_id: row.report_run_id,
    original_run_date: row.original_run_date,
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    direction: row.direction,
    horizon: row.horizon,
    conviction: row.conviction,
    entry_low: row.entry_low,
    entry_high: row.entry_high,
    stop_loss: row.stop_loss,
    target_low: row.target_low,
    target_high: row.target_high,
    status: row.status,
    current_price: row.current_price,
    entry_date: row.entry_date,
    entry_price: row.entry_price,
    exit_date: row.exit_date,
    exit_price: row.exit_price,
    return_pct: row.return_pct,
    days_active: row.days_active,
    status_note: row.status_note,
    ai_followup: row.ai_followup,
  };
}

export async function createLifecycleRowsForIdeas(ideas: Dict[], runDate: string): Promise<void> {
  if (!ideas.length) return;
  const rows = ideas.map((idea) => ({
    trade_idea_id: idea.id,
    report_run_id: idea.report_run_id,
    original_run_date: runDate,
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
    status: "pending_entry",
    status_note: "new idea",
    ai_followup: `${idea.symbol} is newly added today; start tracking from the next trading session.`,
  }));
  const { error } = await db.from("recommendation_lifecycle").upsert(rows, { onConflict: "trade_idea_id" });
  if (error) console.warn("lifecycle new rows warning:", error.message);
}

export async function updateRecommendationLifecycle(): Promise<Dict> {
  await seedMissingLifecycleRows();

  const { data, error } = await db
    .from("recommendation_lifecycle")
    .select("*")
    .not("status", "in", FINAL_STATUS_FILTER)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`recommendation_lifecycle load failed: ${error.message}`);

  const before = (data || []) as LifecycleRow[];
  const updated = before.length ? await runPool(before, 5, updateOne) : [];
  const active = updated.filter((row) => row.status === "active" || row.status === "pending_entry");
  const resolved = updated.filter((row) => FINAL_STATUSES.has(row.status));
  const entered = updated.filter((row) => row.entry_date);
  const positive = entered.filter((row) => Number(row.return_pct || 0) > 0);

  return {
    as_of: new Date().toISOString(),
    checked: updated.length,
    active_count: active.length,
    resolved_count: resolved.length,
    hit_target_count: resolved.filter((row) => row.status === "hit_target").length,
    hit_stop_count: resolved.filter((row) => row.status === "hit_stop").length,
    no_entry_count: resolved.filter((row) => row.status === "no_entry").length,
    win_rate_pct: entered.length ? round((positive.length / entered.length) * 100, 2) : null,
    active: active.sort((a, b) => Math.abs(Number(b.return_pct || 0)) - Math.abs(Number(a.return_pct || 0))).slice(0, 25).map(compact),
    resolved: resolved.sort((a, b) => Math.abs(Number(b.return_pct || 0)) - Math.abs(Number(a.return_pct || 0))).slice(0, 25).map(compact),
  };
}
