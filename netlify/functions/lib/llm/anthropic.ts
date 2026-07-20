/**
 * LLM layer: Claude via the official @anthropic-ai/sdk.
 * Used for per-symbol news sentiment, per-idea rationale, stock deep-dive
 * memos, and the daily narrative. The anti-hallucination allowlist,
 * post-validation, and deterministic fallbacks are load-bearing guardrails.
 *
 * JSON extraction uses the same fence-stripping approach as the Python
 * source rather than a structured-output API, for reliability across SDK
 * versions (the first-pipeline priority).
 */
import Anthropic from "@anthropic-ai/sdk";

const SENTIMENT_MODEL = "claude-haiku-4-5";
const NARRATIVE_MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client = new Anthropic({ apiKey });
  return client;
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function complete(model: string, system: string, prompt: string, maxTokens = 1600): Promise<string> {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// News sentiment
// ---------------------------------------------------------------------------
export interface SentimentResult {
  avg_sentiment: number;
  items: { title: string; sentiment: number; category: string }[];
  error?: string;
}

export async function scoreNewsBatch(symbol: string, headlines: Dict[]): Promise<SentimentResult> {
  if (!headlines || headlines.length === 0) return { avg_sentiment: 0.0, items: [] };
  try {
    const titles = headlines.map((h) => h.title || "").filter((t) => t);
    if (titles.length === 0) return { avg_sentiment: 0.0, items: [] };

    const system =
      "You are a sell-side financial analyst. For every headline, assign " +
      "sentiment in [-1.0, 1.0] (positive/neutral/negative for the company's stock), " +
      "and a category in {earnings, guidance, deal, order-win, regulatory, " +
      "macro, management, litigation, product, other}. " +
      'Respond ONLY with a JSON object: {"items":[{"title":str,"sentiment":float,"category":str}]}';
    const prompt = `Ticker: ${symbol}\nHeadlines:\n${titles.map((t) => `- ${t}`).join("\n")}`;

    let text = (await complete(SENTIMENT_MODEL, system, prompt, 1024)).trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```/, "").replace(/```$/, "");
      if (text.toLowerCase().startsWith("json")) text = text.slice(4);
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { avg_sentiment: 0.0, items: [] };
    const parsed = JSON.parse(text.slice(start, end + 1));
    const items = (parsed.items || []) as { title: string; sentiment: number; category: string }[];
    if (items.length === 0) return { avg_sentiment: 0.0, items: [] };
    const avg = items.reduce((s, i) => s + Number(i.sentiment || 0), 0) / items.length;
    return { avg_sentiment: round(avg, 3), items };
  } catch (err) {
    console.warn(`LLM sentiment failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return { avg_sentiment: 0.0, items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Per-idea rationale
// ---------------------------------------------------------------------------
export async function generateIdeaRationale(idea: Dict, context: Dict): Promise<string> {
  try {
    const system =
      "You are a senior sell-side Indian-equity analyst. Write a concise " +
      "3-5 sentence rationale explaining WHY this stock is a high-conviction " +
      "trade for the stated horizon, citing the specific data provided " +
      "(flows, macro, sector, fundamentals, technicals, sentiment, events). " +
      "Use rupee symbol ₹. No hype, no emojis, no disclaimers. " +
      'End the paragraph with a single-line trade construction: ' +
      '"Entry ₹X–Y · Stop ₹Z · Target ₹A–B · Horizon: weekly/monthly".';

    const relevantFlows = context.flows || [];
    const relevantInsider = (context.insider_highlights || []).filter((x: Dict) => x.symbol === idea.symbol);
    const sector = idea.sector;
    const sectorIndices = (context.sector_indices || []).filter(
      (x: Dict) => sector && (x.index || "").toLowerCase().includes(String(sector).toLowerCase()),
    );
    const sectorBreadth1m = (context.sector_breadth || {})[sector];
    const commodityImpact = (context.commodity_impact || {})[sector];
    const macro = context.macro || {};
    const macroSlim: Dict = {};
    for (const k of ["NIFTY", "BANKNIFTY", "INDIAVIX", "USDINR", "DXY", "CRUDE", "GOLD"]) {
      if (macro[k]) {
        const { history, ...rest } = macro[k];
        void history;
        macroSlim[k] = rest;
      }
    }

    const payload = {
      symbol: idea.symbol,
      name: idea.name,
      sector,
      horizon: idea.horizon,
      direction: idea.direction,
      setup_type: idea.setup_type,
      conviction: idea.conviction,
      sub_scores: idea.sub_scores,
      supporting_reasons: idea.reasons,
      risks: idea.risks,
      next_earnings: idea.next_earnings,
      earnings_in_days: idea.earnings_in_days,
      trade_levels: {
        entry_low: idea.entry_low,
        entry_high: idea.entry_high,
        stop_loss: idea.stop_loss,
        target_low: idea.target_low,
        target_high: idea.target_high,
      },
      sector_context: {
        breadth_1m_pct: sectorBreadth1m,
        sector_indices: sectorIndices.slice(0, 3),
        commodity_impact: commodityImpact,
        is_bullish_sector: (context.bullish_sectors || []).includes(sector),
        is_cautious_sector: (context.cautious_sectors || []).includes(sector),
      },
      market_context: {
        macro: macroSlim,
        fii_net_cr: context.fii_net_cr,
        dii_net_cr: context.dii_net_cr,
        recent_flows: relevantFlows.slice(0, 3),
        insider_flow_for_symbol: relevantInsider,
      },
    };
    const prompt =
      "Write the rationale based ONLY on this data. Reference the specific " +
      "numbers (percentages, ₹ crore values, sub-scores) that make the case.\n\n" +
      `DATA:\n${JSON.stringify(payload).slice(0, 6000)}`;
    return (await complete(NARRATIVE_MODEL, system, prompt, 800)).trim();
  } catch (err) {
    console.warn(`Rationale gen failed for ${idea.symbol}:`, err instanceof Error ? err.message : err);
    return fallbackRationale(idea);
  }
}

export function fallbackRationale(idea: Dict): string {
  const parts: string[] = [];
  const subs = idea.sub_scores || {};
  const reasons = idea.reasons || [];
  const direction = idea.direction || "bullish";
  const horizon = idea.horizon || "weekly";
  const sector = idea.sector || "—";
  const conv = idea.conviction;

  parts.push(`${idea.symbol} (${sector}) clears the ${horizon} conviction gate at ${Number(conv).toFixed(1)}/100.`);
  const entries = Object.entries(subs) as [string, number][];
  if (entries.length) {
    const top = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    parts.push(`Strongest factor: ${top[0].replace(/_/g, " ")} at ${Number(top[1]).toFixed(0)}/100.`);
  }
  if (reasons.length) parts.push("Key supports: " + reasons.slice(0, 3).join("; ") + ".");
  const ed = idea.earnings_in_days;
  if (ed !== null && ed !== undefined) parts.push(`Next earnings ${ed} days out — clear of the holding horizon.`);
  parts.push(
    `Entry ₹${idea.entry_low}–${idea.entry_high} · Stop ₹${idea.stop_loss} · ` +
      `Target ₹${idea.target_low}–${idea.target_high} · Horizon: ${horizon} · Direction: ${direction}.`,
  );
  return parts.join(" ");
}

export type IdeaReview = {
  approved: boolean;
  confidence: number;
  decision: "approve" | "reject" | "watch";
  reason: string;
  red_flags: string[];
};

function fallbackIdeaReview(candidate: Dict): IdeaReview {
  const redFlags: string[] = [];
  const rr = Number(candidate.risk_reward || 0);
  const sub = candidate.sub_scores || {};
  const risks = candidate.risks || [];
  if (rr && rr < 1.8) redFlags.push(`Reward-risk too low (${rr})`);
  if (Number(sub.technical || 50) < 65 && candidate.horizon === "weekly") redFlags.push("Weekly technical score below reviewer comfort");
  if (Number(sub.fundamental || 50) < 62 && candidate.horizon === "monthly") redFlags.push("Monthly fundamental score below reviewer comfort");
  if (risks.some((r: string) => /earnings|results|high leverage|elevated volatility/i.test(r))) redFlags.push("Material risk flag present");
  if (candidate.earnings_in_days !== null && candidate.earnings_in_days !== undefined && candidate.earnings_in_days <= 7) {
    redFlags.push(`Earnings/results event in ${candidate.earnings_in_days} days`);
  }
  const approved = redFlags.length === 0 && Number(candidate.conviction || 0) >= (candidate.horizon === "monthly" ? 75 : 72);
  return {
    approved,
    confidence: approved ? 0.64 : 0.72,
    decision: approved ? "approve" : "reject",
    reason: approved
      ? "Candidate passes deterministic reviewer: conviction, horizon fit, risk-reward and risk flags are acceptable."
      : `Rejected by deterministic reviewer: ${redFlags.join("; ") || "insufficient edge"}.`,
    red_flags: redFlags,
  };
}

export async function generateIdeaReview(candidate: Dict, context: Dict): Promise<IdeaReview> {
  if (context.force_fallback || !llmAvailable()) return fallbackIdeaReview(candidate);
  try {
    const system =
      "You are a skeptical Indian-equity portfolio risk reviewer. Your job is to approve or reject a proposed trade idea. " +
      "Use ONLY the supplied JSON. Do not add new facts. Reject marginal ideas. Prefer capital preservation. " +
      'Respond ONLY as JSON: {"decision":"approve|reject|watch","approved":boolean,"confidence":0-1,"reason":string,"red_flags":[string]}';
    const payload = {
      candidate,
      market_regime: context.market_regime,
      performance_calibration: context.performance_calibration,
      official_data_status: candidate.official_data?.data_sources,
      followup_history: context.followups ? {
        checked: context.followups.checked,
        active_count: context.followups.active_count,
        resolved_count: context.followups.resolved_count,
        win_rate_pct: context.followups.win_rate_pct,
      } : null,
    };
    let text = (await complete(SENTIMENT_MODEL, system, `REVIEW THIS CANDIDATE:\n${JSON.stringify(payload).slice(0, 8000)}`, 900)).trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```/, "").replace(/```$/, "");
      if (text.toLowerCase().startsWith("json")) text = text.slice(4);
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return fallbackIdeaReview(candidate);
    const parsed = JSON.parse(text.slice(start, end + 1)) as Dict;
    const decision = ["approve", "reject", "watch"].includes(parsed.decision) ? parsed.decision : parsed.approved ? "approve" : "reject";
    return {
      approved: Boolean(parsed.approved) && decision === "approve",
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      decision,
      reason: String(parsed.reason || ""),
      red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags.map(String).slice(0, 6) : [],
    };
  } catch (err) {
    console.warn(`Idea review failed for ${candidate.symbol}:`, err instanceof Error ? err.message : err);
    return fallbackIdeaReview(candidate);
  }
}

export async function generateStockDeepDiveMemo(payload: Dict): Promise<string> {
  try {
    const system =
      "You are a senior Indian-equity analyst writing a stock deep-dive memo. " +
      "Use only the supplied JSON data. Be specific, concise, and practical. " +
      "Do not invent unavailable F&O, news, fundamentals, earnings, or ownership data. " +
      "Structure the memo with: Verdict, Technical Setup, Fundamentals, News/Events, F&O, Risks, Action Plan. " +
      "Keep it compact enough for a trading decision. Use rupee symbol ₹. No hype, no emojis, no disclaimers.";
    const prompt =
      "Write a complete but compact deep-dive for this NSE stock using ONLY this data:\n\n" +
      JSON.stringify(payload).slice(0, 9000);
    return (await complete(NARRATIVE_MODEL, system, prompt, 1100)).trim();
  } catch (err) {
    console.warn(`Deep dive memo failed for ${payload.symbol}:`, err instanceof Error ? err.message : err);
    return fallbackStockDeepDiveMemo(payload);
  }
}

export function fallbackStockDeepDiveMemo(payload: Dict): string {
  const score = payload.score || {};
  const tech = payload.technicals || {};
  const fund = payload.fundamentals || {};
  const fno = payload.fno || {};
  const news = payload.news || [];
  const parts = [
    `Verdict: ${payload.symbol} is a ${score.direction || "watch"} setup with conviction ${score.conviction ?? "—"}/100.`,
    `Technical Setup: last close ₹${tech.last_close ?? "—"}, RSI ${tech.rsi_14 ?? "—"}, setup ${tech.setup || "—"}, 1M change ${tech.change_pct_1m ?? "—"}%.`,
    `Fundamentals: market cap ${fund.marketCap ?? "—"}, trailing P/E ${fund.trailingPE ?? "—"}, ROE ${fund.returnOnEquity ?? "—"}, debt/equity ${fund.debtToEquity ?? "—"}.`,
    fno.eligible
      ? `F&O: source ${fno.source}, PCR ${fno.analytics?.pcr ?? "—"}, max call OI ${fno.analytics?.max_oi_call_strike ?? "—"}, max put OI ${fno.analytics?.max_oi_put_strike ?? "—"}.`
      : `F&O: unavailable for this symbol (${fno.providers_tried?.[0]?.error || "not F&O eligible or no data"}).`,
    news.length ? `News/Events: ${news.slice(0, 3).map((n: Dict) => n.title).join("; ")}.` : "News/Events: no fresh matched headlines available.",
  ];
  if (score.reasons?.length) parts.push(`Supports: ${score.reasons.slice(0, 4).join("; ")}.`);
  if (score.risks?.length) parts.push(`Risks: ${score.risks.slice(0, 4).join("; ")}.`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Report narrative (with allowlist guardrail)
// ---------------------------------------------------------------------------
export async function generateReportNarrative(context: Dict): Promise<string> {
  try {
    const allowed: string[] = [];
    for (const key of ["top_weekly", "top_monthly", "excluded_by_earnings"]) {
      for (const item of context[key] || []) {
        const sym = item.symbol;
        if (sym && !allowed.includes(sym)) allowed.push(sym);
      }
    }

    const system =
      "You are the chief market strategist at an Indian long-only fund. " +
      "Write a concise, professional Daily Morning Market Brief for Indian equities. " +
      "Tone: institutional, factual, no hype, no emojis. Use rupee symbol ₹. " +
      "Structure sections with clear headings. Keep under 600 words.\n\n" +
      "ABSOLUTE RULES — violating these is a critical failure:\n" +
      `1. You may mention the following stock symbols and ONLY these: ${allowed.length ? JSON.stringify(allowed) : "[]"}. ` +
      "If this list is empty, do NOT name any individual stock anywhere. " +
      "Do not reference HDFCBANK, RELIANCE, TCS, INFY, ICICIBANK, BHARTIARTL, " +
      "SBIN, or any other company from your training data. Use sector-level commentary only.\n" +
      '2. If `top_weekly` is empty, write: "No tradeable weekly ideas today." ' +
      "If `excluded_by_earnings` contains entries whose `would_qualify` includes " +
      "'weekly', append a sentence listing ONLY those allowed symbols with their " +
      "earnings_in_days. Otherwise append a sector/VIX-based reason without naming any stock.\n" +
      "3. Same rule for `top_monthly` (use entries whose would_qualify contains 'monthly').\n" +
      "4. For every idea you do write, use ONLY fields present in the idea dict " +
      "(symbol, sector, horizon, entry/stop/target, conviction, reasons, risks, " +
      "sub_scores, rationale). Close with entry/stop/target/horizon on one line.\n" +
      "5. Do not speculate about earnings dates for stocks not in the allowlist.";

    const slim = {
      run_date: context.run_date,
      macro: context.macro,
      sector_breadth: context.sector_breadth,
      bullish_sectors: context.bullish_sectors,
      cautious_sectors: context.cautious_sectors,
      top_weekly: context.top_weekly || [],
      top_monthly: context.top_monthly || [],
      excluded_by_earnings: context.excluded_by_earnings || [],
      fii_net_cr: context.fii_net_cr,
      dii_net_cr: context.dii_net_cr,
      risks: context.risks,
      allowed_symbols: allowed,
    };
    const prompt =
      "Produce the brief using ONLY this JSON context. You are permitted to " +
      `reference these symbols and no others: ${JSON.stringify(allowed)}.\n\n` +
      "Required sections: Global Overview, India Macro, Sector Stance, " +
      "Top Weekly Ideas, Top Monthly Ideas, Held-off (earnings calendar), " +
      "Key Risks, Disclaimer.\n\n" +
      "If `top_weekly` or `top_monthly` is empty, follow the ABSOLUTE RULES. " +
      "If `excluded_by_earnings` is empty, omit the Held-off section entirely. " +
      "NEVER reference any stock not in the allowed list above.\n\n" +
      `CONTEXT:\n${JSON.stringify(slim).slice(0, 10000)}`;

    const out = await complete(NARRATIVE_MODEL, system, prompt, 2000);
    if (containsDisallowedSymbol(out, allowed)) {
      console.warn("LLM narrative mentioned unlisted symbols; using fallback.");
      return fallbackNarrative(context);
    }
    return out;
  } catch (err) {
    console.warn("LLM narrative failed:", err instanceof Error ? err.message : err);
    return fallbackNarrative(context);
  }
}

const COMMON_SYMBOLS = new Set([
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "HDFC", "AXISBANK",
  "KOTAKBANK", "BHARTIARTL", "ITC", "HINDUNILVR", "LT", "BAJFINANCE", "ASIANPAINT",
  "MARUTI", "TITAN", "SUNPHARMA", "NESTLEIND", "ULTRACEMCO", "WIPRO", "POWERGRID",
  "ONGC", "NTPC", "HCLTECH", "TECHM", "TATAMOTORS", "TATASTEEL", "JSWSTEEL",
  "ADANIPORTS", "ADANIENT", "COALINDIA", "HDFCLIFE", "SBILIFE", "DRREDDY",
  "CIPLA", "EICHERMOT", "DIVISLAB", "GRASIM", "BRITANNIA", "BAJAJFINSV",
  "BAJAJ-AUTO", "HEROMOTOCO", "INDUSINDBK", "APOLLOHOSP", "UPL", "PIDILITIND",
  "LTIM", "TATACONSUM", "BPCL", "IOC",
]);

export function containsDisallowedSymbol(text: string, allowed: string[]): boolean {
  const up = text.toUpperCase();
  const allowedSet = new Set(allowed.map((a) => a.toUpperCase()));
  for (const sym of COMMON_SYMBOLS) {
    if (allowedSet.has(sym)) continue;
    const idx = up.indexOf(sym);
    if (idx === -1) continue;
    const before = idx > 0 ? up[idx - 1] : " ";
    const after = idx + sym.length < up.length ? up[idx + sym.length] : " ";
    const isAlnum = (c: string) => /[a-z0-9]/i.test(c);
    if (!isAlnum(before) && !isAlnum(after)) return true;
  }
  return false;
}

function fmtSigned(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return x >= 0 ? `+${s}` : s;
}

export function fallbackNarrative(ctx: Dict): string {
  const macro = ctx.macro || {};
  const lines: string[] = ["# Daily Morning Market Brief", ""];

  lines.push("## Global Overview");
  for (const k of ["SP500", "NASDAQ", "NIKKEI", "HANGSENG", "DXY", "US10Y", "CRUDE", "GOLD"]) {
    const m = macro[k];
    if (m) lines.push(`- ${k}: ${m.last} (${fmtSigned(m.change_pct, 2)}%)`);
  }
  lines.push("");
  lines.push("## India Macro");
  for (const k of ["NIFTY", "BANKNIFTY", "INDIAVIX", "USDINR"]) {
    const m = macro[k];
    if (m) lines.push(`- ${k}: ${m.last} (${fmtSigned(m.change_pct, 2)}%)`);
  }
  lines.push("");
  lines.push("## Sector Stance");
  lines.push(`- Bullish: ${(ctx.bullish_sectors || []).join(", ") || "—"}`);
  lines.push(`- Cautious: ${(ctx.cautious_sectors || []).join(", ") || "—"}`);
  lines.push("");

  const renderIdeas = (title: string, ideas: Dict[], emptyMsg: string) => {
    lines.push(`## ${title}`);
    if (!ideas || ideas.length === 0) {
      lines.push(emptyMsg);
      lines.push("");
      return;
    }
    for (const i of ideas) {
      lines.push(`### ${i.symbol} · ${i.sector || "—"} · conviction ${Number(i.conviction).toFixed(1)}`);
      lines.push(i.rationale || fallbackRationale(i));
      lines.push("");
    }
  };

  const excluded = ctx.excluded_by_earnings || [];
  let weeklyEmpty = "No tradeable weekly ideas today.";
  if (excluded.length) {
    weeklyEmpty +=
      " Top-ranked names held off ahead of imminent results: " +
      excluded.slice(0, 5).map((x: Dict) => `${x.symbol} (${x.earnings_in_days}d)`).join(", ") +
      ".";
  }
  const monthlyDeferred = excluded.filter((e: Dict) => (e.would_qualify || []).includes("monthly")).length;
  const monthlyEmpty =
    "No tradeable monthly ideas today." +
    (excluded.length ? ` ${monthlyDeferred} candidate(s) deferred for the earnings window.` : "");

  renderIdeas("Top Weekly Ideas", ctx.top_weekly || [], weeklyEmpty);
  renderIdeas("Top Monthly Ideas", ctx.top_monthly || [], monthlyEmpty);

  if (excluded.length) {
    lines.push("## Held-off (Earnings Calendar)");
    lines.push("High-conviction names being watched until results are out:");
    for (const e of excluded.slice(0, 8)) {
      lines.push(
        `- **${e.symbol}** (${e.sector || "—"}) · conviction ${Number(e.conviction).toFixed(1)} · ` +
          `next earnings ${e.next_earnings} (${e.earnings_in_days} days).`,
      );
    }
    lines.push("");
  }

  lines.push("## Key Risks");
  for (const r of ctx.risks && ctx.risks.length ? ctx.risks : ["Global volatility", "FII flow reversal"]) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push("## Disclaimer");
  lines.push(
    "This report is for informational purposes only and is not investment advice. " +
      "Markets carry risk. Consult a SEBI-registered advisor before trading.",
  );
  return lines.join("\n");
}
