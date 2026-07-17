"""Stock Deep Dive Explorer — single-symbol orchestrator.

Orchestrates a per-stock fetch across every existing connector + service:
  • universe lookup (refresh EQUITY_L if missing)
  • live NSE quote
  • 1-yr OHLCV from yfinance
  • full technical snapshot (RSI/SMA/EMA/MACD/BB/ATR/vol-spike/RS + S/R)
  • fundamentals (FMP if configured else yfinance .info)
  • corporate announcements + corp actions + financial-results calendar
  • news (yfinance + RSS) → Claude sentiment per headline
  • F&O option-chain summary (PCR + top calls/puts) when eligible
  • single-stock 7-factor scoring
  • Claude synthesis: weekly + monthly buy/hold/sell with entry/exit levels

Persists every fetch in `stock_deep_dives` so subsequent reads in <15 min are
cache hits unless `force_refresh=True`.
"""
from __future__ import annotations
import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pandas as pd

from db import (
    deep_dives_col, news_col, stock_universe_col,
    technicals_col, scores_col,
)
from connectors.market_data import (
    EquityHistoryConnector, NewsConnector,
)
from connectors.nse import (
    NSEQuoteConnector, NSEOptionChainConnector, NSEFinancialResultsConnector,
    NSECorpAnnouncementsConnector, NSECorpActionsConnector,
)
from connectors.rss_news import RSSNewsConnector
from services import sentiment, scoring
from services.indicators import compute_snapshot
from services.report import _build_snapshots, IST  # noqa: F401

logger = logging.getLogger(__name__)

# Re-fetch budget — cache hits inside this window unless force_refresh=True
CACHE_TTL_MINUTES = 15


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Validation + universe lookup
# ---------------------------------------------------------------------------
async def _resolve_symbol(symbol: str) -> Optional[Dict[str, Any]]:
    """Find symbol in stock_universe; if missing, refresh EQUITY_L and retry."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    u = await stock_universe_col.find_one({"symbol": sym}, {"_id": 0})
    if u:
        return u
    # Try refreshing the universe — the user may have searched a brand-new listing
    try:
        from stock_universe import seed_full_nse_universe
        await seed_full_nse_universe()
    except Exception as e:  # noqa: BLE001
        logger.warning("Universe refresh during deep-dive failed: %s", e)
    return await stock_universe_col.find_one({"symbol": sym}, {"_id": 0})


async def search_universe(query: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Autocomplete search across symbol + name. Case-insensitive substring."""
    q = (query or "").strip()
    if len(q) < 1:
        return []
    # Symbol prefix is the strongest signal — boost those first
    prefix = await stock_universe_col.find(
        {"symbol": {"$regex": f"^{q}", "$options": "i"}},
        {"_id": 0, "symbol": 1, "name": 1, "sector": 1, "industry": 1},
    ).limit(limit).to_list(limit)
    if len(prefix) >= limit:
        return prefix
    # Then name substring matches (excluding what we already have)
    have = {p["symbol"] for p in prefix}
    rest_n = limit - len(prefix)
    name_hits = await stock_universe_col.find(
        {"name": {"$regex": q, "$options": "i"},
         "symbol": {"$nin": list(have)}},
        {"_id": 0, "symbol": 1, "name": 1, "sector": 1, "industry": 1},
    ).limit(rest_n).to_list(rest_n)
    return prefix + name_hits


# ---------------------------------------------------------------------------
# Fetch helpers — each fault-isolated so one outage never blocks the whole view
# ---------------------------------------------------------------------------
async def _fetch_quote(symbol: str) -> Optional[Dict[str, Any]]:
    try:
        res = await NSEQuoteConnector().run(symbols=[symbol])
        return (res.get("data") or {}).get(symbol)
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive quote %s failed: %s", symbol, e)
        return None


async def _fetch_history(yf_symbol: str) -> Optional[pd.DataFrame]:
    try:
        res = await EquityHistoryConnector().run(tickers=[yf_symbol])
        data = res.get("data") or {}
        return data.get(yf_symbol)
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive history %s failed: %s", yf_symbol, e)
        return None


async def _fetch_fundamentals(yf_symbol: str) -> Dict[str, Any]:
    try:
        from services.report import _get_info_sync_for
        return await _get_info_sync_for(yf_symbol) or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive fundamentals %s failed: %s", yf_symbol, e)
        return {}


async def _fetch_news_block(yf_symbol: str, symbol: str) -> List[Dict[str, Any]]:
    """Merge yfinance + RSS news for a single symbol."""
    items: List[Dict[str, Any]] = []
    try:
        yf_res = await NewsConnector().run(ticker=yf_symbol, limit=12)
        items.extend(yf_res.get("data") or [])
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive yfinance news %s failed: %s", yf_symbol, e)
    try:
        rss_res = await RSSNewsConnector().run(symbols=[symbol])
        rss_items = (rss_res.get("data") or {}).get(symbol) or []
        # Normalise to news-block shape
        for r in rss_items:
            items.append({
                "title": r.get("title"),
                "link": r.get("link"),
                "published": r.get("pub_date"),
                "source": r.get("source", "rss"),
                "description": r.get("description"),
            })
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive rss news %s failed: %s", symbol, e)
    # De-dup on title
    import re as _re
    seen = set()
    dedup: List[Dict[str, Any]] = []
    for it in items:
        t = _re.sub(r"\s+", " ", (it.get("title") or "").lower()).strip()
        if not t or t in seen:
            continue
        seen.add(t)
        dedup.append(it)
    return dedup[:20]


async def _fetch_corp_events(symbol: str) -> Dict[str, Any]:
    """Pull NSE corp announcements + corp actions + nearest results date for
    a single symbol from the existing connectors and filter to this symbol."""
    out: Dict[str, Any] = {"announcements": [], "actions": [], "next_earnings": None}
    try:
        ann_res = await NSECorpAnnouncementsConnector().run()
        all_ann = ann_res.get("data") or []
        out["announcements"] = [a for a in all_ann
                                if (a.get("symbol") or "").upper() == symbol][:10]
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive corp_ann %s failed: %s", symbol, e)
    try:
        act_res = await NSECorpActionsConnector().run()
        all_act = (act_res.get("data") or {}).get(symbol) or []
        out["actions"] = all_act[:10]
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive corp_actions %s failed: %s", symbol, e)
    try:
        fin_res = await NSEFinancialResultsConnector().run()
        fin_map = fin_res.get("data") or {}
        out["next_earnings"] = fin_map.get(symbol)
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive financial_results %s failed: %s", symbol, e)
    return out


async def _fetch_option_chain(symbol: str) -> Dict[str, Any]:
    """Delegate to the provider-chain orchestrator (Upstox → Fyers → NSE →
    yfinance). Always returns a dict with `eligible`, `source`, `error` and
    — when populated — `analytics` with PCR / ATM / max-OI / bias / confidence.
    """
    try:
        from services.fno import get_option_chain
        return await get_option_chain(symbol)
    except Exception as e:  # noqa: BLE001
        logger.warning("deep_dive option_chain %s failed: %s", symbol, e)
        return {"eligible": False, "source": "none",
                "error": str(e)[:160], "analytics": None}


# ---------------------------------------------------------------------------
# Trade plan (entry / target / stop) for the buy / sell / hold call
# ---------------------------------------------------------------------------
def _trade_plan(snap: Dict[str, Any], score: Dict[str, Any]) -> Dict[str, Any]:
    """Compute entry-band / stop / targets using ATR multiples on top of the
    last close and the technical setup. Mirrors the same formulae used by
    the daily scanner so the deep-dive ideas are consistent with the report.

    Robustness: when ATR is missing (single-ticker yfinance edge case), we
    fall back to a 2 % proxy of the last close so users still get a usable
    entry/exit band rather than an empty plan.
    """
    last = float(snap.get("last_close") or 0)
    atr = snap.get("atr_14")
    if atr is None or atr == 0:
        atr = round(last * 0.02, 2) if last else 0  # 2 % proxy
    atr = float(atr)
    direction = score.get("direction") or "neutral"
    if not last or not atr:
        return {}
    if direction == "bullish":
        entry_low = round(last - 0.4 * atr, 2)
        entry_high = round(last + 0.2 * atr, 2)
        stop = round(last - 1.6 * atr, 2)
        t1 = round(last + 2.0 * atr, 2)
        t2 = round(last + 3.5 * atr, 2)
    elif direction == "bearish":
        entry_low = round(last - 0.2 * atr, 2)
        entry_high = round(last + 0.4 * atr, 2)
        stop = round(last + 1.6 * atr, 2)
        t1 = round(last - 2.0 * atr, 2)
        t2 = round(last - 3.5 * atr, 2)
    else:
        # Neutral / hold — show a watch band only
        return {"action": "hold",
                "entry_low": round(last * 0.98, 2),
                "entry_high": round(last * 1.02, 2),
                "stop_loss": round(last * 0.92, 2),
                "target_1": None, "target_2": None,
                "rr": None}
    rr = round(abs(t1 - last) / max(abs(stop - last), 0.01), 2)
    return {"entry_low": entry_low, "entry_high": entry_high,
            "stop_loss": stop, "target_1": t1, "target_2": t2,
            "rr": rr, "direction": direction}


def _verdict(score: Dict[str, Any], horizon: str) -> str:
    """Return BUY / HOLD / SELL / AVOID for a given horizon based on
    conviction + direction + filter pass status."""
    if not score.get("passes_filters"):
        return "avoid"
    conv = score.get("conviction") or 0
    direction = score.get("direction") or "neutral"
    if direction == "bearish":
        return "sell"
    if direction == "neutral":
        return "hold"
    # bullish — gate on horizon-specific conviction floor
    floor = 70 if horizon == "weekly" else 65
    if conv >= floor:
        return "buy"
    if conv >= 55:
        return "hold"
    return "avoid"


# ---------------------------------------------------------------------------
# AI summary — one Claude call, strictly grounded on the fetched data
# ---------------------------------------------------------------------------
async def _ai_summary(payload: Dict[str, Any]) -> Optional[str]:
    if not os.environ.get("EMERGENT_LLM_KEY"):
        return None
    try:
        sym = payload["symbol"]
        snap = payload["technicals"]
        sc = payload["score"]
        plan_w = payload["weekly"]["plan"]
        plan_m = payload["monthly"]["plan"]
        nws = payload.get("news") or []
        fno = payload.get("fno") or {}
        fno_line = (
            f"F&O bias: {fno.get('analytics', {}).get('bias')} "
            f"(PCR={fno.get('analytics', {}).get('pcr')}, "
            f"confidence={fno.get('analytics', {}).get('confidence')}, "
            f"source={fno.get('source')})"
            if fno.get("eligible") and fno.get("analytics")
            else "F&O signal unavailable — do not mention options / PCR / OI in the memo."
        )
        compact = {
            "symbol": sym, "name": payload.get("name"),
            "last_close": snap.get("last_close"),
            "rsi_14": snap.get("rsi_14"),
            "trend": "above" if (snap.get("last_close") or 0) > (snap.get("sma_50") or 0) else "below",
            "conviction": sc.get("conviction"), "direction": sc.get("direction"),
            "weekly_verdict": payload["weekly"]["verdict"],
            "monthly_verdict": payload["monthly"]["verdict"],
            "weekly_plan": plan_w, "monthly_plan": plan_m,
            "top_news": [n.get("title") for n in nws[:5]],
            "fno_context": fno_line,
            "fundamentals": {k: v for k, v in (payload.get("fundamentals") or {}).items()
                             if k in ("pe", "pb", "roe", "marketCap", "earningsGrowth", "debtToEquity")},
        }
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=os.environ["EMERGENT_LLM_KEY"],
            session_id=f"deep-dive-{sym}-{uuid.uuid4()}",
            system_message=(
                "You are a buy-side equity analyst writing a 90-second deep-dive "
                "memo for a portfolio manager. STRICTLY use the JSON facts "
                "provided — never invent numbers, company history, or news. "
                "Output 4 short paragraphs (max ~110 words each):\n"
                "1) Current setup (price action + trend + RSI in plain English).\n"
                "2) Fundamental + flow context.\n"
                "3) Recommended weekly play (use given verdict and entry/stop/target).\n"
                "4) Recommended monthly play (same).\n"
                "Use plain English, no headings, no bullet lists, no markdown."
            ),
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        msg = UserMessage(text=f"FACTS:\n{compact}")
        resp = await chat.send_message(msg)
        # send_message returns content directly (string) per emergentintegrations
        return (resp or "").strip() if isinstance(resp, str) else str(resp)
    except Exception as e:  # noqa: BLE001
        logger.warning("AI summary failed for %s: %s", payload.get("symbol"), e)
        return None


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------
async def fetch_stock_deep_dive(
    symbol: str, force_refresh: bool = False, skip_llm: bool = False,
) -> Dict[str, Any]:
    """Single entry point. Returns a normalized JSON payload for the UI."""
    sym = (symbol or "").strip().upper()
    universe_row = await _resolve_symbol(sym)
    if not universe_row:
        raise ValueError(f"Symbol {sym!r} not found in NSE universe")

    # Cache check
    if not force_refresh:
        cached = await deep_dives_col.find_one(
            {"symbol": sym}, {"_id": 0}, sort=[("fetched_at", -1)]
        )
        if cached:
            try:
                fetched_at = datetime.fromisoformat(cached["fetched_at"])
                if (_now() - fetched_at) < timedelta(minutes=CACHE_TTL_MINUTES):
                    cached["from_cache"] = True
                    return cached
            except Exception:  # noqa: BLE001
                pass

    yf_sym = universe_row.get("yf_symbol") or f"{sym}.NS"

    # Fan-out parallel fetch — every leg is fault-isolated
    quote, hist, info, news_items, events, fno = await asyncio.gather(
        _fetch_quote(sym),
        _fetch_history(yf_sym),
        _fetch_fundamentals(yf_sym),
        _fetch_news_block(yf_sym, sym),
        _fetch_corp_events(sym),
        _fetch_option_chain(sym),
        return_exceptions=False,
    )

    # Build technical snapshot
    snap: Dict[str, Any] = {}
    if hist is not None and len(hist) > 30:
        try:
            snap = compute_snapshot(hist) or {}
            snap.update({
                "symbol": sym,
                "name": universe_row.get("name"),
                "sector": universe_row.get("sector"),
            })
        except Exception as e:  # noqa: BLE001
            logger.warning("compute_snapshot %s failed: %s", sym, e)

    # Per-headline sentiment (LLM, capped to 8)
    sentiment_block = {"avg_sentiment": 0.0, "items": news_items}
    if news_items and not skip_llm:
        try:
            sentiment_block = await sentiment.score_news_batch(sym, news_items[:8])
        except Exception as e:  # noqa: BLE001
            logger.warning("deep_dive sentiment %s failed: %s", sym, e)

    # Pull most-recent stored score for this symbol (from last daily run) —
    # if the deep-dive is the first time we score this stock, fall back to
    # a synthetic neutral score so the UI never crashes.
    score = await scores_col.find_one(
        {"symbol": sym}, {"_id": 0}, sort=[("as_of", -1)]
    ) or {
        "symbol": sym, "conviction": 50,
        "direction": "neutral", "horizon_tag": "watch",
        "passes_filters": False, "filter_rejects": ["no_prior_run"],
        "technical": 50, "fundamental": 50, "valuation": 50,
        "ownership": 50, "analyst": 50, "event_news": 50, "macro_sector": 50,
    }

    weekly_plan = _trade_plan(snap, score)
    monthly_plan = _trade_plan(snap, score)
    weekly_verdict = _verdict(score, "weekly")
    monthly_verdict = _verdict(score, "monthly")

    payload: Dict[str, Any] = {
        "symbol": sym, "name": universe_row.get("name"),
        "sector": universe_row.get("sector"),
        "industry": universe_row.get("industry"),
        "yf_symbol": yf_sym,
        "fetched_at": _now().isoformat(),
        "from_cache": False,
        "quote": quote or {},
        "technicals": snap,
        # Last 250 daily bars for the chart (open/high/low/close + volume)
        "ohlc": _hist_to_rows(hist),
        "fundamentals": info,
        "news": news_items,
        "sentiment": sentiment_block,
        "events": events,
        "fno": fno,
        "score": score,
        "weekly": {"verdict": weekly_verdict, "plan": weekly_plan,
                   "horizon_days": 7},
        "monthly": {"verdict": monthly_verdict, "plan": monthly_plan,
                    "horizon_days": 30},
    }

    # Optional AI memo
    payload["ai_summary"] = None if skip_llm else await _ai_summary(payload)

    # Persist (we keep the raw OHLC out of the cache to avoid bloating Mongo)
    cache_doc = dict(payload)
    cache_doc["ohlc"] = (cache_doc.get("ohlc") or [])[-90:]  # keep last 90 bars in cache
    cache_doc["id"] = str(uuid.uuid4())
    await deep_dives_col.insert_one(dict(cache_doc))
    cache_doc.pop("_id", None)
    return payload


def _hist_to_rows(hist) -> List[Dict[str, Any]]:
    if hist is None or len(hist) == 0:
        return []
    df = hist.tail(250)
    rows: List[Dict[str, Any]] = []
    for ts, row in df.iterrows():
        try:
            # row is a pandas Series; access by label, falling back across
            # capitalisation variants in case of upstream quirks
            def _v(*keys):
                for k in keys:
                    if k in row.index:
                        return row[k]
                return None
            rows.append({
                "date": str(ts.date()) if hasattr(ts, "date") else str(ts),
                "open": float(_v("Open", "open") or 0),
                "high": float(_v("High", "high") or 0),
                "low": float(_v("Low", "low") or 0),
                "close": float(_v("Close", "close") or 0),
                "volume": float(_v("Volume", "volume") or 0),
            })
        except Exception:  # noqa: BLE001
            continue
    return rows
