import test from "node:test";
import assert from "node:assert/strict";
import {
  assessDataConfidence,
  entryStopTarget,
  finalConvictionForHorizon,
  structureAwareEntryStopTarget,
  FINAL_WEIGHTS,
} from "../lib/scoring/scoring.js";

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

test("horizon conviction rewards technicals more for weekly and fundamentals more for monthly", () => {
  const sub = {
    technical: 88,
    fundamental: 58,
    valuation: 55,
    ownership: 60,
    analyst: 50,
    event_news: 62,
    macro_sector: 64,
  };
  assert.ok(finalConvictionForHorizon(sub, "weekly") > finalConvictionForHorizon(sub, "monthly"));
});

test("data confidence penalizes missing official data and flags monthly blockers", () => {
  const quality = assessDataConfidence({
    snapshot: { last_close: 100, rsi_14: 58, atr_14: 2 },
    info: {},
    fmp: {},
    official: { data_sources: {} },
    flows: { fiiNetCr: null, diiNetCr: null },
    newsItems: 0,
  });
  assert.ok(quality.score < 85);
  assert.ok(quality.penalty > 0);
  assert.ok(quality.blockers.includes("fundamentals missing"));
});
