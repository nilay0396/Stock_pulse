import test from "node:test";
import assert from "node:assert/strict";
import { simulateTrade } from "../routes/backtests.js";
import type { DatedOhlcvBar } from "../lib/market/yahoo.js";

const idea = {
  id: "idea-1",
  report_run_id: "run-1",
  symbol: "TEST",
  direction: "bullish",
  horizon: "weekly",
  entry_low: 100,
  entry_high: 102,
  stop_loss: 95,
  target_low: 110,
  target_high: 120,
};

function bar(date: string, low: number, high: number, close: number, open = close): DatedOhlcvBar {
  return { date, open, low, high, close, volume: 100000 };
}

test("backtest books target 1 and final target as blended return", () => {
  const result = simulateTrade([
    bar("2026-07-02", 100, 103, 101),
    bar("2026-07-03", 109, 111, 110),
    bar("2026-07-04", 115, 121, 120),
  ], idea) as Record<string, unknown>;
  assert.equal(result.outcome, "hit_target");
  assert.equal(result.target1_price, 110);
  assert.equal(result.exit_price, 120);
  assert.ok(Number(result.return_pct) > 10);
});

test("backtest records trailing stop instead of calling target 1 a completed win", () => {
  const result = simulateTrade([
    bar("2026-07-02", 100, 103, 101),
    bar("2026-07-03", 109, 111, 110),
    bar("2026-07-04", 102, 109, 106),
  ], idea) as Record<string, unknown>;
  assert.equal(result.outcome, "hit_trailing_stop");
  assert.equal(result.target1_price, 110);
  assert.ok(result.trailing_stop);
});
