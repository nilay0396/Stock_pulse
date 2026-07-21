import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLifecycle, type LifecycleRow } from "../lib/pipeline/lifecycle.js";
import type { DatedOhlcvBar } from "../lib/market/yahoo.js";

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: "life-1",
    trade_idea_id: "idea-1",
    report_run_id: "run-1",
    original_run_date: "2026-07-01",
    symbol: "TEST",
    direction: "bullish",
    horizon: "weekly",
    entry_low: 100,
    entry_high: 102,
    stop_loss: 95,
    target_low: 110,
    target_high: 120,
    status: "pending_entry",
    ...overrides,
  };
}

function bar(date: string, low: number, high: number, close: number, open = close): DatedOhlcvBar {
  return { date, open, low, high, close, volume: 100000 };
}

test("lifecycle moves pending idea to active when entry range trades", () => {
  const next = evaluateLifecycle(row(), [bar("2026-07-02", 100.5, 103, 102)], new Date("2026-07-03T00:00:00Z"));
  assert.equal(next.status, "active");
  assert.equal(next.entry_date, "2026-07-02");
  assert.ok(next.entry_price);
});

test("lifecycle records target 1 without closing the whole trade", () => {
  const next = evaluateLifecycle(row(), [
    bar("2026-07-02", 100, 103, 101),
    bar("2026-07-03", 104, 111, 110),
  ], new Date("2026-07-03T00:00:00Z"));
  assert.equal(next.status, "target_1_hit");
  assert.equal(next.target1_price, 110);
  assert.equal(next.exit_price, null);
  assert.equal(next.partial_exit_pct, 50);
});

test("lifecycle closes remaining position only when final target is reached", () => {
  const next = evaluateLifecycle(row(), [
    bar("2026-07-02", 100, 103, 101),
    bar("2026-07-03", 104, 111, 110),
    bar("2026-07-04", 112, 121, 120),
  ], new Date("2026-07-04T00:00:00Z"));
  assert.equal(next.status, "hit_target");
  assert.equal(next.exit_price, 120);
  assert.ok(Number(next.return_pct) > 0);
});

test("lifecycle can close on trailing stop after target 1", () => {
  const next = evaluateLifecycle(row(), [
    bar("2026-07-02", 100, 103, 101),
    bar("2026-07-03", 104, 111, 110),
    bar("2026-07-04", 102, 109, 106),
  ], new Date("2026-07-04T00:00:00Z"));
  assert.equal(next.status, "hit_trailing_stop");
  assert.equal(next.target1_price, 110);
  assert.ok(next.trailing_stop);
});

test("lifecycle expires as no_entry after horizon if entry never trades", () => {
  const next = evaluateLifecycle(row(), [bar("2026-07-02", 105, 108, 107)], new Date("2026-07-09T00:00:00Z"));
  assert.equal(next.status, "no_entry");
});
