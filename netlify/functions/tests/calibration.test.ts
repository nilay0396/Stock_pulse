import test from "node:test";
import assert from "node:assert/strict";
import { calibrationAdjustment } from "../lib/pipeline/enrichment.js";

test("calibrationAdjustment combines sector, horizon, setup, regime and AI buckets", () => {
  const calibration = {
    adjustments: {
      "sector:Banking": 1,
      "horizon:weekly": -1,
      "direction:bullish": 2,
      "setup:breakout": 1,
      "regime:risk_on_trend": 1,
      "ai_confidence:high": 2,
    },
  };
  const idea = {
    sector: "Banking",
    horizon: "weekly",
    direction: "bullish",
    setup_type: "breakout",
    ai_review: { confidence: 0.82 },
  };
  assert.equal(calibrationAdjustment(calibration, idea, "risk_on_trend"), 5);
});

test("calibrationAdjustment is clamped to avoid runaway score changes", () => {
  const calibration = {
    adjustments: {
      "sector:Other": -2,
      "horizon:monthly": -2,
      "direction:bullish": -2,
      "setup:neutral": -2,
      "regime:risk_off": -2,
      "ai_confidence:low": -2,
    },
  };
  const idea = {
    sector: "Other",
    horizon: "monthly",
    direction: "bullish",
    setup_type: "neutral",
    ai_review: { confidence: 0.3 },
  };
  assert.equal(calibrationAdjustment(calibration, idea, "risk_off"), -5);
});
