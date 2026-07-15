"""Claude Sonnet 4.5 (via Emergent LLM key) news sentiment scoring + report narrative."""
from __future__ import annotations
import json
import logging
import os
from typing import List, Dict, Any, Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)

EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY")
MODEL_PROVIDER = "anthropic"
MODEL_NAME = "claude-sonnet-4-5-20250929"


def _new_chat(session_id: str, system: str) -> LlmChat:
    if not EMERGENT_KEY:
        raise RuntimeError("EMERGENT_LLM_KEY missing in environment")
    return LlmChat(
        api_key=EMERGENT_KEY,
        session_id=session_id,
        system_message=system,
    ).with_model(MODEL_PROVIDER, MODEL_NAME)


async def score_news_batch(symbol: str, headlines: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return {'avg_sentiment': -1..1, 'items': [{'title','sentiment','category'}...]}"""
    if not headlines:
        return {"avg_sentiment": 0.0, "items": []}
    try:
        chat = _new_chat(
            session_id=f"sentiment-{symbol}",
            system=(
                "You are a sell-side financial analyst. For every headline, assign "
                "sentiment in [-1.0, 1.0] (positive/neutral/negative for the company's stock), "
                "and a category in {earnings, guidance, deal, order-win, regulatory, "
                "macro, management, litigation, product, other}. "
                "Respond ONLY with a JSON object: {\"items\":[{\"title\":str,\"sentiment\":float,\"category\":str}]}"
            ),
        )
        titles = [h.get("title", "") for h in headlines if h.get("title")]
        if not titles:
            return {"avg_sentiment": 0.0, "items": []}
        prompt = (
            f"Ticker: {symbol}\nHeadlines:\n" + "\n".join(f"- {t}" for t in titles)
        )
        resp = await chat.send_message(UserMessage(text=prompt))
        # extract JSON
        text = resp.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1:
            return {"avg_sentiment": 0.0, "items": []}
        parsed = json.loads(text[start : end + 1])
        items = parsed.get("items", []) or []
        if not items:
            return {"avg_sentiment": 0.0, "items": []}
        avg = sum(float(i.get("sentiment", 0)) for i in items) / len(items)
        return {"avg_sentiment": round(avg, 3), "items": items}
    except Exception as e:  # noqa: BLE001
        logger.warning("LLM sentiment failed for %s: %s", symbol, e)
        return {"avg_sentiment": 0.0, "items": [], "error": str(e)}


async def generate_idea_rationale(idea: Dict[str, Any], context: Dict[str, Any]) -> str:
    """Produce a focused "why this is a good bet" paragraph for a single idea.

    Uses every data point the pipeline collected — sub-scores, reasons, risks,
    sector breadth, FII/DII flow, INDIAVIX, macro/commodity impact, insider
    activity, upcoming corporate actions, analyst sentiment, and news sentiment.
    Keeps it factual (3-5 sentences, <120 words) and closes with the trade
    construction (entry / stop / target / horizon).
    """
    try:
        chat = _new_chat(
            session_id=f"idea-rationale-{context.get('run_date','today')}-{idea['symbol']}",
            system=(
                "You are a senior sell-side Indian-equity analyst. Write a concise "
                "3-5 sentence rationale explaining WHY this stock is a high-conviction "
                "trade for the stated horizon, citing the specific data provided "
                "(flows, macro, sector, fundamentals, technicals, sentiment, events). "
                "Use rupee symbol ₹. No hype, no emojis, no disclaimers. "
                "End the paragraph with a single-line trade construction: "
                "\"Entry ₹X–Y · Stop ₹Z · Target ₹A–B · Horizon: weekly/monthly\"."
            ),
        )
        # Build a lean, focused payload so the model keys on the right signals
        relevant_flows = context.get("flows") or []
        relevant_insider = [
            x for x in (context.get("insider_highlights") or [])
            if x.get("symbol") == idea["symbol"]
        ]
        sector = idea.get("sector")
        sector_indices = [
            x for x in (context.get("sector_indices") or [])
            if sector and sector.lower() in (x.get("index") or "").lower()
        ]
        sector_breadth_1m = (context.get("sector_breadth") or {}).get(sector)
        commodity_impact = (context.get("commodity_impact") or {}).get(sector)
        macro = context.get("macro") or {}
        macro_slim = {
            k: {kk: vv for kk, vv in (macro.get(k) or {}).items() if kk != "history"}
            for k in ("NIFTY", "BANKNIFTY", "INDIAVIX", "USDINR", "DXY", "CRUDE", "GOLD")
            if macro.get(k)
        }

        payload = {
            "symbol": idea["symbol"],
            "name": idea.get("name"),
            "sector": sector,
            "horizon": idea["horizon"],
            "direction": idea["direction"],
            "setup_type": idea.get("setup_type"),
            "conviction": idea["conviction"],
            "sub_scores": idea.get("sub_scores"),
            "supporting_reasons": idea.get("reasons"),
            "risks": idea.get("risks"),
            "next_earnings": idea.get("next_earnings"),
            "earnings_in_days": idea.get("earnings_in_days"),
            "trade_levels": {
                "entry_low": idea.get("entry_low"), "entry_high": idea.get("entry_high"),
                "stop_loss": idea.get("stop_loss"),
                "target_low": idea.get("target_low"), "target_high": idea.get("target_high"),
            },
            "sector_context": {
                "breadth_1m_pct": sector_breadth_1m,
                "sector_indices": sector_indices[:3],
                "commodity_impact": commodity_impact,
                "is_bullish_sector": sector in (context.get("bullish_sectors") or []),
                "is_cautious_sector": sector in (context.get("cautious_sectors") or []),
            },
            "market_context": {
                "macro": macro_slim,
                "fii_net_cr": context.get("fii_net_cr"),
                "dii_net_cr": context.get("dii_net_cr"),
                "recent_flows": relevant_flows[:3],
                "insider_flow_for_symbol": relevant_insider,
            },
        }
        prompt = (
            "Write the rationale based ONLY on this data. Reference the specific "
            "numbers (percentages, ₹ crore values, sub-scores) that make the case.\n\n"
            f"DATA:\n{json.dumps(payload, default=str)[:6000]}"
        )
        return (await chat.send_message(UserMessage(text=prompt))).strip()
    except Exception as e:  # noqa: BLE001
        logger.warning("Rationale gen failed for %s: %s", idea.get("symbol"), e)
        return _fallback_rationale(idea)


def _fallback_rationale(idea: Dict[str, Any]) -> str:
    """Deterministic rationale so skip_llm runs still produce something useful."""
    parts: List[str] = []
    subs = idea.get("sub_scores") or {}
    reasons = idea.get("reasons") or []
    direction = idea.get("direction", "bullish")
    horizon = idea.get("horizon", "weekly")
    sector = idea.get("sector") or "—"
    conv = idea.get("conviction")

    parts.append(
        f"{idea['symbol']} ({sector}) clears the {horizon} conviction gate at "
        f"{conv:.1f}/100."
    )
    # call out the strongest sub-score
    if subs:
        top = max(subs.items(), key=lambda x: x[1])
        parts.append(
            f"Strongest factor: {top[0].replace('_',' ')} at {top[1]:.0f}/100."
        )
    if reasons:
        parts.append("Key supports: " + "; ".join(reasons[:3]) + ".")
    ed = idea.get("earnings_in_days")
    if ed is not None:
        parts.append(f"Next earnings {ed} days out — clear of the holding horizon.")
    parts.append(
        f"Entry ₹{idea.get('entry_low')}–{idea.get('entry_high')} · "
        f"Stop ₹{idea.get('stop_loss')} · "
        f"Target ₹{idea.get('target_low')}–{idea.get('target_high')} · "
        f"Horizon: {horizon} · Direction: {direction}."
    )
    return " ".join(parts)


async def generate_report_narrative(context: Dict[str, Any]) -> str:
    """Create the written morning-report body from aggregated intelligence."""
    try:
        # Allowlist = every stock the model is permitted to reference by name.
        # This is the hard barrier against hallucinated recommendations.
        allowed: List[str] = []
        for key in ("top_weekly", "top_monthly", "excluded_by_earnings"):
            for item in (context.get(key) or []):
                sym = item.get("symbol")
                if sym and sym not in allowed:
                    allowed.append(sym)

        chat = _new_chat(
            session_id=f"report-narrative-{context.get('run_date','today')}",
            system=(
                "You are the chief market strategist at an Indian long-only fund. "
                "Write a concise, professional Daily Morning Market Brief for Indian equities. "
                "Tone: institutional, factual, no hype, no emojis. Use rupee symbol ₹. "
                "Structure sections with clear headings. Keep under 600 words.\n\n"
                "ABSOLUTE RULES — violating these is a critical failure:\n"
                f"1. You may mention the following stock symbols and ONLY these: "
                f"{allowed if allowed else '[]'}. "
                "If this list is empty, do NOT name any individual stock anywhere. "
                "Do not reference HDFCBANK, RELIANCE, TCS, INFY, ICICIBANK, BHARTIARTL, "
                "SBIN, or any other company from your training data. Use sector-level "
                "commentary only.\n"
                "2. If `top_weekly` is empty, write: \"No tradeable weekly ideas today.\" "
                "If `excluded_by_earnings` contains entries whose `would_qualify` includes "
                "'weekly', append a sentence listing ONLY those allowed symbols with their "
                "earnings_in_days. Otherwise append a sector/VIX-based reason without naming "
                "any stock.\n"
                "3. Same rule for `top_monthly` (use entries whose would_qualify contains 'monthly').\n"
                "4. For every idea you do write, use ONLY fields present in the idea dict "
                "(symbol, sector, horizon, entry/stop/target, conviction, reasons, risks, "
                "sub_scores, rationale). Close with entry/stop/target/horizon on one line.\n"
                "5. Do not speculate about earnings dates for stocks not in the allowlist."
            ),
        )
        slim = {
            "run_date": context.get("run_date"),
            "macro": context.get("macro"),
            "sector_breadth": context.get("sector_breadth"),
            "bullish_sectors": context.get("bullish_sectors"),
            "cautious_sectors": context.get("cautious_sectors"),
            "top_weekly": context.get("top_weekly") or [],
            "top_monthly": context.get("top_monthly") or [],
            "excluded_by_earnings": context.get("excluded_by_earnings") or [],
            "fii_net_cr": context.get("fii_net_cr"),
            "dii_net_cr": context.get("dii_net_cr"),
            "risks": context.get("risks"),
            "allowed_symbols": allowed,
        }
        prompt = (
            "Produce the brief using ONLY this JSON context. You are permitted to "
            f"reference these symbols and no others: {allowed}.\n\n"
            "Required sections: Global Overview, India Macro, Sector Stance, "
            "Top Weekly Ideas, Top Monthly Ideas, Held-off (earnings calendar), "
            "Key Risks, Disclaimer.\n\n"
            "If `top_weekly` or `top_monthly` is empty, follow the ABSOLUTE RULES. "
            "If `excluded_by_earnings` is empty, omit the Held-off section entirely. "
            "NEVER reference any stock not in the allowed list above.\n\n"
            f"CONTEXT:\n{json.dumps(slim, default=str)[:10000]}"
        )
        out = await chat.send_message(UserMessage(text=prompt))
        # Defence-in-depth: post-validate. If the model mentions any stock not in
        # the allowlist, fall back to the deterministic narrative.
        if _contains_disallowed_symbol(out, allowed):
            logger.warning("LLM narrative mentioned unlisted symbols; using fallback.")
            return _fallback_narrative(context)
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("LLM narrative failed: %s", e)
        return _fallback_narrative(context)


# Top-50 NSE symbols that might appear as hallucinations. Cheap allowlist check.
_COMMON_SYMBOLS = {
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "HDFC", "AXISBANK",
    "KOTAKBANK", "BHARTIARTL", "ITC", "HINDUNILVR", "LT", "BAJFINANCE", "ASIANPAINT",
    "MARUTI", "TITAN", "SUNPHARMA", "NESTLEIND", "ULTRACEMCO", "WIPRO", "POWERGRID",
    "ONGC", "NTPC", "HCLTECH", "TECHM", "TATAMOTORS", "TATASTEEL", "JSWSTEEL",
    "ADANIPORTS", "ADANIENT", "COALINDIA", "HDFCLIFE", "SBILIFE", "DRREDDY",
    "CIPLA", "EICHERMOT", "DIVISLAB", "GRASIM", "BRITANNIA", "BAJAJFINSV",
    "BAJAJ-AUTO", "HEROMOTOCO", "INDUSINDBK", "APOLLOHOSP", "UPL", "PIDILITIND",
    "LTIM", "TATACONSUM", "BPCL", "IOC",
}


def _contains_disallowed_symbol(text: str, allowed: List[str]) -> bool:
    up = text.upper()
    allowed_set = {a.upper() for a in allowed}
    for sym in _COMMON_SYMBOLS:
        if sym in allowed_set:
            continue
        # Word-boundary check using dot/comma/space/paren around the token
        if sym in up:
            # Very cheap boundary check
            idx = up.find(sym)
            before = up[idx - 1] if idx > 0 else " "
            after = up[idx + len(sym)] if idx + len(sym) < len(up) else " "
            if not before.isalnum() and not after.isalnum():
                return True
    return False


def _fallback_narrative(ctx: Dict[str, Any]) -> str:
    macro = ctx.get("macro", {})
    lines = ["# Daily Morning Market Brief", ""]
    lines.append("## Global Overview")
    for k in ("SP500", "NASDAQ", "NIKKEI", "HANGSENG", "DXY", "US10Y", "CRUDE", "GOLD"):
        m = macro.get(k)
        if m:
            lines.append(f"- {k}: {m['last']} ({m['change_pct']:+.2f}%)")
    lines.append("")
    lines.append("## India Macro")
    for k in ("NIFTY", "BANKNIFTY", "INDIAVIX", "USDINR"):
        m = macro.get(k)
        if m:
            lines.append(f"- {k}: {m['last']} ({m['change_pct']:+.2f}%)")
    lines.append("")
    lines.append("## Sector Stance")
    lines.append(f"- Bullish: {', '.join(ctx.get('bullish_sectors', [])) or '—'}")
    lines.append(f"- Cautious: {', '.join(ctx.get('cautious_sectors', [])) or '—'}")
    lines.append("")

    def _render_ideas(section_title: str, ideas: List[Dict[str, Any]], empty_msg: str):
        lines.append(f"## {section_title}")
        if not ideas:
            lines.append(empty_msg)
            lines.append("")
            return
        for i in ideas:
            lines.append(f"### {i['symbol']} · {i.get('sector') or '—'} · conviction {i['conviction']:.1f}")
            rationale = i.get("rationale") or _fallback_rationale(i)
            lines.append(rationale)
            lines.append("")

    excluded = ctx.get("excluded_by_earnings") or []
    weekly_empty_reason = "No tradeable weekly ideas today."
    if excluded:
        weekly_empty_reason += (
            " Top-ranked names held off ahead of imminent results: "
            + ", ".join(f"{x['symbol']} ({x.get('earnings_in_days')}d)" for x in excluded[:5])
            + "."
        )
    monthly_empty_reason = "No tradeable monthly ideas today." + (
        f" {len([e for e in excluded if 'monthly' in (e.get('would_qualify') or [])])} "
        f"candidate(s) deferred for the earnings window." if excluded else ""
    )

    _render_ideas("Top Weekly Ideas", ctx.get("top_weekly") or [], weekly_empty_reason)
    _render_ideas("Top Monthly Ideas", ctx.get("top_monthly") or [], monthly_empty_reason)

    if excluded:
        lines.append("## Held-off (Earnings Calendar)")
        lines.append("High-conviction names being watched until results are out:")
        for e in excluded[:8]:
            lines.append(
                f"- **{e['symbol']}** ({e.get('sector') or '—'}) · "
                f"conviction {e['conviction']:.1f} · "
                f"next earnings {e.get('next_earnings')} "
                f"({e.get('earnings_in_days')} days)."
            )
        lines.append("")

    lines.append("## Key Risks")
    for r in ctx.get("risks", []) or ["Global volatility", "FII flow reversal"]:
        lines.append(f"- {r}")
    lines.append("")
    lines.append("## Disclaimer")
    lines.append("This report is for informational purposes only and is not investment advice. "
                 "Markets carry risk. Consult a SEBI-registered advisor before trading.")
    return "\n".join(lines)
