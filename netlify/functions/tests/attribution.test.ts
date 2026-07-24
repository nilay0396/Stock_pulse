import test from "node:test";
import assert from "node:assert/strict";
import { buildAttribution, summarizeAttributionFactors } from "../lib/pipeline/attribution.js";

const lifecycle = {
  id: "life-1",
  trade_idea_id: "idea-1",
  report_run_id: "run-1",
  original_run_date: "2026-07-01",
  symbol: "TEST",
  status: "hit_target",
  return_pct: 4.2,
};

const idea = {
  id: "idea-1",
  sector: "Capital Goods",
  horizon: "weekly",
  direction: "bullish",
  setup_type: "breakout",
  market_regime: "risk_on_trend",
  risk_reward: 2.4,
  ai_review: { decision: "approve", confidence: 0.8 },
  reasons: ["Volume 2x avg", "Sector leading"],
  risks: ["Elevated VIX"],
};

test("buildAttribution credits reasons and context for profitable outcomes", () => {
  const out = buildAttribution(lifecycle, idea);
  assert.equal(out.profit_loss, "profit");
  assert.equal(out.outcome, "hit_target");
  assert.ok(out.attribution_score > 0);
  assert.ok(out.reason_tags.includes("volume_2x_avg"));
  assert.ok(out.context_tags.includes("setup_breakout"));

  const reason = out.factor_attributions.find((x: any) => x.key === "reason:volume_2x_avg");
  assert.equal(reason.effect, "helped");
  assert.ok(reason.weight > 0);
});

test("buildAttribution penalizes realized risks for losing outcomes", () => {
  const out = buildAttribution({ ...lifecycle, status: "hit_stop", return_pct: -3.1 }, idea);
  assert.equal(out.profit_loss, "loss");
  assert.ok(out.attribution_score < 0);

  const risk = out.factor_attributions.find((x: any) => x.key === "risk:elevated_vix");
  assert.equal(risk.effect, "hurt");
  assert.ok(risk.weight < -1);
});

test("summarizeAttributionFactors aggregates recurring factor weights", () => {
  const rows = [
    buildAttribution(lifecycle, idea),
    buildAttribution({ ...lifecycle, id: "life-2", return_pct: 3.2 }, idea),
    buildAttribution({ ...lifecycle, id: "life-3", return_pct: 2.8 }, idea),
  ];
  const summary = summarizeAttributionFactors(rows, 3);
  const item = summary.find((x) => x.key === "reason:volume_2x_avg");
  assert.equal(item?.count, 3);
  assert.ok(Number(item?.avg_weight || 0) > 0);
});
