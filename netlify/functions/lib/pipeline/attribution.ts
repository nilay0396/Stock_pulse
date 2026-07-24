import { db } from "../db.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

const FINAL_STATUSES = ["hit_target", "hit_stop", "hit_trailing_stop", "expired"];
const NEGATIVE_OUTCOMES = new Set(["hit_stop", "expired"]);
const POSITIVE_OUTCOMES = new Set(["hit_target"]);

export type AttributionFactor = {
  type: "reason" | "risk" | "context";
  key: string;
  label: string;
  weight: number;
  effect: "helped" | "hurt" | "neutral";
};

function round(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function cleanToken(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function textTag(value: unknown): string | null {
  const token = cleanToken(value);
  return token.length >= 3 ? token : null;
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function profitLoss(returnPct: unknown, outcome: string): "profit" | "loss" | "flat" {
  const pct = Number(returnPct);
  if (Number.isFinite(pct)) {
    if (pct > 0.05) return "profit";
    if (pct < -0.05) return "loss";
  }
  if (POSITIVE_OUTCOMES.has(outcome)) return "profit";
  if (NEGATIVE_OUTCOMES.has(outcome)) return "loss";
  return "flat";
}

function factorWeight(pl: "profit" | "loss" | "flat", type: AttributionFactor["type"], returnPct: number): number {
  if (pl === "flat") return 0;
  const magnitude = Math.min(2, Math.max(0.75, Math.abs(returnPct || 0) / 2.5));
  const sign = pl === "profit" ? 1 : -1;
  if (type === "risk") return round(sign < 0 ? -1.25 * magnitude : -0.35 * magnitude);
  return round(sign * magnitude);
}

function factor(type: AttributionFactor["type"], label: string, pl: "profit" | "loss" | "flat", returnPct: number): AttributionFactor | null {
  const tag = textTag(label);
  if (!tag) return null;
  const weight = factorWeight(pl, type, returnPct);
  return {
    type,
    key: `${type}:${tag}`,
    label: String(label).trim(),
    weight,
    effect: weight > 0 ? "helped" : weight < 0 ? "hurt" : "neutral",
  };
}

export function buildAttribution(row: Dict, idea: Dict): Dict {
  const outcome = String(row.status || "unknown");
  const returnPct = Number(row.return_pct || 0);
  const pl = profitLoss(row.return_pct, outcome);
  const reasonLabels = Array.isArray(idea.reasons) ? idea.reasons : [];
  const riskLabels = Array.isArray(idea.risks) ? idea.risks : [];
  const contextLabels = [
    idea.sector ? `sector:${idea.sector}` : null,
    idea.horizon ? `horizon:${idea.horizon}` : null,
    idea.direction ? `direction:${idea.direction}` : null,
    idea.setup_type ? `setup:${idea.setup_type}` : null,
    idea.market_regime ? `regime:${idea.market_regime}` : null,
    idea.risk_reward ? `risk_reward:${Number(idea.risk_reward) >= 2 ? "favorable" : "thin"}` : null,
    idea.ai_review?.decision ? `ai_decision:${idea.ai_review.decision}` : null,
    Number(idea.ai_review?.confidence || 0) >= 0.75
      ? "ai_confidence:high"
      : Number(idea.ai_review?.confidence || 0) >= 0.55
        ? "ai_confidence:medium"
        : Number(idea.ai_review?.confidence || 0) > 0
          ? "ai_confidence:low"
          : "ai_confidence:unknown",
  ];

  const factors = [
    ...reasonLabels.map((label) => factor("reason", label, pl, returnPct)),
    ...riskLabels.map((label) => factor("risk", label, pl, returnPct)),
    ...contextLabels.map((label) => factor("context", label || "", pl, returnPct)),
  ].filter((x): x is AttributionFactor => Boolean(x));

  factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const primary = factors[0]?.label || null;
  const attributionScore = round(factors.reduce((sum, item) => sum + item.weight, 0));

  return {
    lifecycle_id: row.id,
    trade_idea_id: row.trade_idea_id,
    report_run_id: row.report_run_id,
    original_run_date: row.original_run_date,
    symbol: row.symbol,
    outcome,
    return_pct: Number.isFinite(Number(row.return_pct)) ? Number(row.return_pct) : null,
    profit_loss: pl,
    attribution_score: attributionScore,
    primary_driver: primary,
    factor_attributions: factors,
    reason_tags: unique(reasonLabels.map(textTag)),
    risk_tags: unique(riskLabels.map(textTag)),
    context_tags: unique(contextLabels.map(textTag)),
    updated_at: new Date().toISOString(),
  };
}

export async function updateRecommendationAttributions(): Promise<Dict> {
  const { data: lifecycle, error } = await db
    .from("recommendation_lifecycle")
    .select("id,trade_idea_id,report_run_id,original_run_date,symbol,status,return_pct")
    .in("status", FINAL_STATUSES)
    .limit(1000);
  if (error) throw new Error(`recommendation_lifecycle attribution load failed: ${error.message}`);

  const rows = lifecycle || [];
  const ideaIds = rows.map((row) => row.trade_idea_id).filter(Boolean);
  const { data: ideas, error: ideaError } = ideaIds.length
    ? await db
        .from("trade_ideas")
        .select("id,sector,horizon,direction,setup_type,risk_reward,market_regime,ai_review,reasons,risks")
        .in("id", ideaIds)
    : { data: [], error: null };
  if (ideaError) throw new Error(`trade_ideas attribution load failed: ${ideaError.message}`);

  const ideaMap = new Map((ideas || []).map((idea) => [idea.id, idea as Dict]));
  const attributions = rows.map((row) => buildAttribution(row, ideaMap.get(row.trade_idea_id) || {}));
  if (attributions.length) {
    const { error: upsertError } = await db
      .from("recommendation_attributions")
      .upsert(attributions, { onConflict: "lifecycle_id" });
    if (upsertError) throw new Error(`recommendation_attributions upsert failed: ${upsertError.message}`);
  }

  const profits = attributions.filter((row) => row.profit_loss === "profit").length;
  const losses = attributions.filter((row) => row.profit_loss === "loss").length;
  return {
    checked: rows.length,
    upserted: attributions.length,
    profit_count: profits,
    loss_count: losses,
    flat_count: attributions.length - profits - losses,
  };
}

export function summarizeAttributionFactors(rows: Dict[], minCount = 3): Dict[] {
  const buckets = new Map<string, Dict[]>();
  for (const row of rows) {
    const factors = Array.isArray(row.factor_attributions) ? row.factor_attributions : [];
    for (const item of factors) {
      const key = String(item.key || "");
      if (!key) continue;
      const bucket = buckets.get(key) || [];
      bucket.push({ ...item, return_pct: row.return_pct, profit_loss: row.profit_loss });
      buckets.set(key, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([key, items]) => {
      const avgWeight = items.reduce((sum, item) => sum + Number(item.weight || 0), 0) / items.length;
      const avgReturn = items.reduce((sum, item) => sum + Number(item.return_pct || 0), 0) / items.length;
      const wins = items.filter((item) => item.profit_loss === "profit").length;
      return {
        key,
        type: String(items[0]?.type || key.split(":")[0] || "factor"),
        label: String(items[0]?.label || key),
        count: items.length,
        hit_rate_pct: round((wins / items.length) * 100, 2),
        avg_return_pct: round(avgReturn),
        avg_weight: round(avgWeight),
      };
    })
    .filter((row) => row.count >= minCount)
    .sort((a, b) => Math.abs(Number(b.avg_weight || 0)) - Math.abs(Number(a.avg_weight || 0)));
}
