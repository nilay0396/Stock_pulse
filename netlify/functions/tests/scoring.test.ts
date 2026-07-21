import test from "node:test";
import assert from "node:assert/strict";
import { entryStopTarget, structureAwareEntryStopTarget, FINAL_WEIGHTS } from "../lib/scoring/scoring.js";

const bars = Array.from({ length: 60 }, (_v, i) => {
  const base = 96 + i * 0.35;
  return {
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + 0.8,
    volume: 100000 + i * 1200,
  };
});

test("final weights sum to 1", () => {
  const sum = Object.values(FINAL_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100), 100);
});

test("bullish ATR levels keep stop below entry and target above entry", () => {
  const levels = entryStopTarget(100, 2, "bullish", "weekly");
  assert.ok(levels.entry_low < levels.entry_high);
  assert.ok(levels.stop_loss < levels.entry_low);
  assert.ok(levels.target_low > levels.entry_high);
  assert.ok(levels.target_high > levels.target_low);
  assert.ok(levels.risk_reward >= 2);
});

test("bearish ATR levels keep stop above entry and target below entry", () => {
  const levels = entryStopTarget(100, 2, "bearish", "weekly");
  assert.ok(levels.entry_low < levels.entry_high);
  assert.ok(levels.stop_loss > levels.entry_high);
  assert.ok(levels.target_high < levels.entry_low);
  assert.ok(levels.target_low < levels.target_high);
  assert.ok(levels.risk_reward >= 2);
});

test("structure-aware bullish construction preserves reward-risk discipline", () => {
  const levels = structureAwareEntryStopTarget(118, 3, "bullish", "weekly", bars);
  assert.ok(levels.stop_loss < levels.entry_low);
  assert.ok(levels.target_low > levels.entry_high);
  assert.ok(levels.risk_reward >= 2);
  assert.match(levels.construction || "", /structure|fallback/);
});
