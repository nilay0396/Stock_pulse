"""Stage 1 funnel — full-universe lightweight prefilter.

The institutional funnel runs in three stages:

  Stage 1: scan FULL NSE EQ-series universe (~2000 stocks) using only cheap
           sources (bhavcopy → yfinance OHLC), compute lightweight technicals,
           and shortlist the top ~200 candidates.
  Stage 2: deep ingest (yfinance .info, FMP fundamentals, shareholding, news,
           LLM sentiment, earnings calendar) ONLY on the shortlisted candidates.
  Stage 3: existing strict scoring + idea selection on the deep-scanned 200.

This module owns Stage 1 — gating, composite ranking, and shortlist selection.
It deliberately uses no LLM and no per-stock HTTP calls, so it scales linearly
with universe size.
"""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

logger = logging.getLogger(__name__)

# Liquidity / price gates applied on bhavcopy rows BEFORE we even download
# their OHLC. These cuts typically reduce 2,000 → ~600-900 names.
PREFILTER_MIN_PRICE = 50.0
PREFILTER_MIN_TURNOVER_CR = 1.0           # ₹1 cr/day average
PREFILTER_MIN_DELIV_PCT = 20.0            # ≥ 20% delivery (kills speculative)


def prefilter_by_bhavcopy(
    universe: List[Dict[str, Any]],
    bhav_map: Dict[str, Dict[str, Any]],
    min_price: float = PREFILTER_MIN_PRICE,
    min_turnover_cr: float = PREFILTER_MIN_TURNOVER_CR,
    min_deliv_pct: float = PREFILTER_MIN_DELIV_PCT,
) -> List[Dict[str, Any]]:
    """First pass: keep only universe entries whose latest EOD bhavcopy row
    clears price + turnover + delivery thresholds.

    Stocks NOT present in bhavcopy (newly listed, halted, ETF-listed under
    different series) are dropped at this stage — they wouldn't be tradable
    anyway.
    """
    out: List[Dict[str, Any]] = []
    for u in universe:
        sym = u.get("symbol", "").upper()
        b = bhav_map.get(sym)
        if not b:
            continue
        close = b.get("close") or 0.0
        if close < min_price:
            continue
        turnover_cr = (b.get("turnover_lacs") or 0.0) / 100.0
        if turnover_cr < min_turnover_cr:
            continue
        deliv = b.get("deliv_pct")
        # Allow stocks where DELIV_PER is missing — some series don't report it.
        if deliv is not None and deliv < min_deliv_pct:
            continue
        out.append({**u, "_bhav_close": close, "_bhav_turnover_cr": turnover_cr,
                    "_bhav_deliv_pct": deliv})
    return out


def lightweight_setup_score(snap: Dict[str, Any]) -> Tuple[float, List[str]]:
    """Composite 0-100 score using ONLY the cheap technical fields the
    `compute_snapshot()` returns. No fundamentals, no news, no LLM.

    Components (each 0-100):
      - Trend stack (price vs SMA50/SMA200 + golden cross)
      - RSI sweet zone (40-72)
      - Momentum (1m change)
      - Volume spike (1.3-3x avg = accumulation)
      - Relative strength vs NIFTY
      - ATR-volatility band (1.0-4.0 % of price)
    Equally weighted to keep the funnel impartial across setup types.
    """
    last = snap.get("last_close") or 0.0
    sma50 = snap.get("sma_50") or 0.0
    sma200 = snap.get("sma_200") or 0.0
    rsi_v = snap.get("rsi_14")
    mom_1m = snap.get("change_pct_1m") or 0.0
    spike = snap.get("volume_spike") or 1.0
    rel = snap.get("relative_strength") or 0.0
    atr_v = snap.get("atr_14") or 0.0

    reasons: List[str] = []

    # 1) Trend: 0/33/66/100
    trend_score = 0.0
    if sma50 and last > sma50:
        trend_score += 33
    if sma200 and last > sma200:
        trend_score += 33
    if sma50 and sma200 and sma50 > sma200:
        trend_score += 34
    if trend_score >= 66:
        reasons.append("Above SMA-50/200")

    # 2) RSI
    rsi_score = 50.0
    if rsi_v is not None:
        if 50 <= rsi_v <= 65:
            rsi_score = 100
            reasons.append(f"RSI sweet ({rsi_v:.0f})")
        elif 40 <= rsi_v < 50 or 65 < rsi_v <= 72:
            rsi_score = 75
        elif rsi_v < 30 or rsi_v > 78:
            rsi_score = 20
        else:
            rsi_score = 55

    # 3) Momentum 1m
    mom_score = max(0.0, min(100.0, 50 + mom_1m * 2.5))   # +20% mom → 100
    if mom_1m >= 5:
        reasons.append(f"+{mom_1m:.1f}% 1m")

    # 4) Volume spike
    if 1.3 <= spike <= 3.0:
        vol_score = 100.0
        reasons.append(f"Vol {spike:.1f}x avg")
    elif spike >= 1.0:
        vol_score = 70.0
    elif spike >= 0.7:
        vol_score = 50.0
    else:
        vol_score = 25.0

    # 5) Relative strength vs NIFTY (in %)
    rs_score = max(0.0, min(100.0, 50 + rel * 5))
    if rel > 5:
        reasons.append(f"RS +{rel:.1f}% vs NIFTY")

    # 6) ATR / price ratio
    atr_score = 50.0
    if atr_v and last:
        ratio = atr_v / last * 100
        if 1.0 <= ratio <= 4.0:
            atr_score = 100.0
        elif ratio < 1.0 or ratio > 6.0:
            atr_score = 25.0
        else:
            atr_score = 60.0

    composite = (trend_score + rsi_score + mom_score + vol_score + rs_score + atr_score) / 6
    return round(composite, 2), reasons[:3]


def rank_and_shortlist(
    snapshots: List[Dict[str, Any]],
    universe_by_sym: Dict[str, Dict[str, Any]],
    top_n: int = 200,
    min_setup_score: float = 50.0,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Score every snapshot, sort by composite descending, return:
        (shortlisted_universe_rows, all_setup_rows)

    `all_setup_rows` is kept (and persisted by the caller) for transparency:
    every prefilter-pool stock plus its lightweight score, so the dashboard
    can show "why this name didn't make it" in a follow-up drilldown.
    """
    rows: List[Dict[str, Any]] = []
    for snap in snapshots:
        score, reasons = lightweight_setup_score(snap)
        rows.append({
            "symbol": snap["symbol"],
            "sector": snap.get("sector") or "Other",
            "name": snap.get("name") or snap["symbol"],
            "last_close": snap.get("last_close"),
            "rsi_14": snap.get("rsi_14"),
            "change_pct_1m": snap.get("change_pct_1m"),
            "volume_spike": snap.get("volume_spike"),
            "relative_strength": snap.get("relative_strength"),
            "setup": snap.get("setup"),
            "lite_score": score,
            "lite_reasons": reasons,
        })
    rows.sort(key=lambda r: r["lite_score"], reverse=True)

    # Apply minimum cutoff so we never deep-scan dead names just to fill 200
    qualified = [r for r in rows if r["lite_score"] >= min_setup_score]
    shortlisted_syms = [r["symbol"] for r in qualified[:top_n]]
    shortlisted = [universe_by_sym[s] for s in shortlisted_syms if s in universe_by_sym]
    return shortlisted, rows


def chunk(items: List[Any], size: int) -> List[List[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]
