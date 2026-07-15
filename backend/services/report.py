"""End-to-end daily report pipeline (institutional 3-stage funnel).

Stage 1  (services/prefilter.py + services/ingestion.ingest_stage1_*):
  Scan FULL NSE EQ-series universe (~2,000 stocks) using ONLY cheap sources
  — bhavcopy gates (price / turnover / delivery), then batched yfinance OHLC,
  then a lightweight technical composite. Shortlists top ~200 candidates.

Stage 2  (services/ingestion.ingest_stage2_deep):
  Deep ingest (yfinance .info, FMP fundamentals, shareholding, RSS news, LLM
  sentiment, earnings calendar, corporate actions) ONLY on shortlisted names.

Stage 3  (this file):
  Existing strict scoring + idea selection + narrative + delivery, applied to
  the deep-scanned 200 to produce final 5-15 weekly/monthly trade ideas.

Funnel statistics (universe → prefilter → shortlist → scored → ideas) are
persisted on the report run for dashboard transparency.
"""
from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import pytz

from db import (
    ideas_col, news_col, preferences_col, report_runs_col, scores_col,
    stock_universe_col, technicals_col, users_col, deliveries_col,
)
from connectors.market_data import NewsConnector
from services import scoring, sentiment, delivery_email, delivery_telegram, prefilter
from services.indicators import compute_snapshot
from services.ingestion import (
    IngestedData,
    ingest_stage1_market_wide, ingest_stage1_ohlc, ingest_stage2_deep,
)

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")

# Holding-horizon safety buffers — skip a stock from a weekly/monthly idea list
# if its next earnings announcement falls inside this many days from the run.
_WEEKLY_HOLD_DAYS = 10
_MONTHLY_HOLD_DAYS = 35

# Export-oriented sectors (USDINR up = tailwind) for macro scoring
_EXPORT_SECTORS = {"IT", "Pharma", "Chemicals"}


def _today_ist_str() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


async def _fetch_universe() -> List[Dict[str, Any]]:
    # Pull the full NSE EQ-series universe (currently ~2,168 stocks). The
    # 5,000 ceiling protects against runaway growth without arbitrarily
    # capping at a smaller number that would silently exclude listings.
    return await stock_universe_col.find({}, {"_id": 0}).to_list(5000)


async def _get_info_sync_for(ticker: str) -> Dict[str, Any]:
    import yfinance as yf
    loop = asyncio.get_running_loop()

    def _get():
        try:
            return yf.Ticker(ticker).info or {}
        except Exception:
            return {}

    return await loop.run_in_executor(None, _get)


def _compute_sector_breadth(rows: List[Dict[str, Any]]) -> Dict[str, float]:
    agg: Dict[str, List[float]] = {}
    for r in rows:
        s = r.get("sector") or "Other"
        c = r.get("change_pct_1m")
        if c is None:
            continue
        agg.setdefault(s, []).append(c)
    return {k: round(sum(v) / len(v), 2) for k, v in agg.items() if v}


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------
def _build_snapshots(
    universe: List[Dict[str, Any]], ing: IngestedData,
) -> List[Dict[str, Any]]:
    snapshots: List[Dict[str, Any]] = []
    now = datetime.now(timezone.utc).isoformat()
    for u in universe:
        df = ing.hist.get(u["yf_symbol"])
        if df is None or df.empty:
            continue
        snap = compute_snapshot(df, benchmark_close=ing.nifty_series)
        if not snap:
            continue
        snap.update({"symbol": u["symbol"], "sector": u["sector"],
                     "name": u["name"], "as_of": now})
        snapshots.append(snap)
    return snapshots


async def _persist_snapshots(snapshots: List[Dict[str, Any]]) -> None:
    for snap in snapshots:
        await technicals_col.update_one({"symbol": snap["symbol"]}, {"$set": snap}, upsert=True)


async def _fetch_info_cache(
    universe: List[Dict[str, Any]], max_n: int,
) -> Dict[str, Dict[str, Any]]:
    info_cache: Dict[str, Dict[str, Any]] = {}

    async def _one(u):
        info_cache[u["symbol"]] = await _get_info_sync_for(u["yf_symbol"])

    await asyncio.gather(*[_one(u) for u in universe[:max_n]], return_exceptions=True)
    return info_cache


async def _fetch_news_sentiment(
    snapshots: List[Dict[str, Any]], universe: List[Dict[str, Any]],
    run_date: str, skip_llm: bool, rss_by_symbol: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Fetch headlines for every symbol in parallel, MERGE with RSS headlines
    collected during ingestion (ET/BS/MC/Reuters), persist, and compute
    per-symbol sentiment. Multi-source coverage reduces yfinance dependency.

    Deduplication: headlines are normalised on title and kept once.
    """
    news_conn = NewsConnector()
    uni_map = {u["symbol"]: u for u in universe}
    rss_by_symbol = rss_by_symbol or {}

    async def _fetch(snap):
        symbol = snap["symbol"]
        uni = uni_map.get(symbol)
        if not uni:
            return symbol, []
        try:
            res = await news_conn.run(ticker=uni["yf_symbol"], limit=8)
            return symbol, res.get("data") or []
        except Exception:  # noqa: BLE001
            return symbol, []

    results = await asyncio.gather(*[_fetch(s) for s in snapshots])

    def _norm(t: str) -> str:
        import re as _re
        return _re.sub(r"\s+", " ", _re.sub(r"[^a-z0-9 ]", " ", (t or "").lower())).strip()

    out: Dict[str, Dict[str, Any]] = {}
    now = datetime.now(timezone.utc).isoformat()
    for symbol, headlines in results:
        # Merge RSS items — normalise each RSS row to the {title, link, ...}
        # shape the rest of the pipeline expects.
        rss_items = rss_by_symbol.get(symbol) or []
        merged: List[Dict[str, Any]] = list(headlines or [])
        seen_titles = {_norm(h.get("title", "")) for h in merged}
        for it in rss_items:
            title = it.get("title") or ""
            nt = _norm(title)
            if not nt or nt in seen_titles:
                continue
            seen_titles.add(nt)
            merged.append({
                "title": title, "link": it.get("link"),
                "published": it.get("pub_date"),
                "source": it.get("source", "rss"),
                "description": it.get("description"),
            })

        if merged:
            await news_col.insert_many([
                dict({**h, "symbol": symbol, "run_date": run_date, "ingested_at": now})
                for h in merged
            ])
        if skip_llm or not merged:
            out[symbol] = {"avg_sentiment": 0.0, "items": merged}
        else:
            out[symbol] = await sentiment.score_news_batch(symbol, merged)
    return out


def _build_sector_peer_arrays(
    snapshots: List[Dict[str, Any]], universe_syms: Dict[str, Dict[str, Any]],
    info_cache: Dict[str, Dict[str, Any]], fmp_data: Dict[str, Any],
) -> Tuple[Dict[str, List[float]], Dict[str, List[float]], Dict[str, List[float]]]:
    """Peer-percentile inputs for valuation scoring."""
    pe_by: Dict[str, List[float]] = {}
    pb_by: Dict[str, List[float]] = {}
    ev_by: Dict[str, List[float]] = {}
    for snap in snapshots:
        sym = snap["symbol"]
        sec = universe_syms.get(sym, {}).get("sector", "Other")
        info = info_cache.get(sym) or {}
        if info.get("trailingPE") is not None:
            pe_by.setdefault(sec, []).append(info["trailingPE"])
        if info.get("priceToBook") is not None:
            pb_by.setdefault(sec, []).append(info["priceToBook"])
        ev = ((fmp_data.get(sym) or {}).get("metrics_ttm") or {}).get("enterpriseValueOverEBITDATTM")
        if ev is not None:
            ev_by.setdefault(sec, []).append(ev)
    return pe_by, pb_by, ev_by


def _compute_raw_scores(
    snapshots: List[Dict[str, Any]], ing: IngestedData,
    info_cache: Dict[str, Dict[str, Any]], news_sentiment: Dict[str, Dict[str, Any]],
    universe_syms: Dict[str, Dict[str, Any]], sector_breadth: Dict[str, float],
    pe_by: Dict[str, List[float]], pb_by: Dict[str, List[float]], ev_by: Dict[str, List[float]],
) -> List[Dict[str, Any]]:
    """One dict per snapshot, containing raw sub-scores + reasons + risks."""
    vix = (ing.macro.get("INDIAVIX") or {}).get("last")
    usdinr_chg = (ing.macro.get("USDINR") or {}).get("change_pct")
    dxy_chg = (ing.macro.get("DXY") or {}).get("change_pct")
    gl_changes = [(ing.macro.get(k) or {}).get("change_pct")
                  for k in ("SP500", "NASDAQ", "NIKKEI", "HANGSENG", "FTSE")]
    gl_changes = [x for x in gl_changes if x is not None]
    global_avg_chg = sum(gl_changes) / len(gl_changes) if gl_changes else None

    out: List[Dict[str, Any]] = []
    for snap in snapshots:
        symbol = snap["symbol"]
        info = info_cache.get(symbol) or {}
        bhav_row = ing.bhav_map.get(symbol)
        ins_row = ing.insider_map.get(symbol)
        fmp_row = ing.fmp_data.get(symbol)
        sector = snap["sector"]
        uni_row = universe_syms.get(symbol, {})

        passes, rejects = scoring.apply_hard_filters(
            snap, uni_row, bhav_row, min_price=50.0, min_turnover_cr=1.0,
        )

        s_tech, r_tech = scoring.score_technical(snap)
        s_fund, r_fund = scoring.score_fundamentals(info, fmp_row)
        s_val, r_val = scoring.score_valuation(
            info, fmp_row,
            sector_pe=pe_by.get(sector, []),
            sector_pb=pb_by.get(sector, []),
            sector_ev=ev_by.get(sector, []),
        )
        s_own, r_own = scoring.score_ownership(
            info, bhav=bhav_row, insider=ins_row,
            fii_net_cr=ing.fii_net, dii_net_cr=ing.dii_net,
        )
        s_an, r_an = scoring.score_analyst(info, fmp_row)
        ns = news_sentiment.get(symbol, {"avg_sentiment": 0.0, "items": []})
        upcoming_actions = ing.corp_actions_map.get(symbol, [])
        s_news, r_news = scoring.score_event_news(
            ns.get("avg_sentiment", 0.0), len(ns.get("items", [])),
            upcoming_actions=upcoming_actions,
        )
        s_macro, r_macro = scoring.score_macro_sector(
            sector, sector_breadth,
            vix=vix, usdinr_chg=usdinr_chg, dxy_chg=dxy_chg,
            commodity_impact=ing.commodity_sector.get(sector, 0.0),
            global_avg_chg=global_avg_chg,
            is_export_sector=sector in _EXPORT_SECTORS,
        )

        raw_sub = {
            "technical": s_tech, "fundamental": s_fund, "valuation": s_val,
            "ownership": s_own, "analyst": s_an, "event_news": s_news, "macro_sector": s_macro,
        }
        reasons = r_tech + r_fund + r_val + r_an + r_news + r_macro
        risks = list(rejects)
        if (snap.get("volatility_20") or 0) > 40:
            risks.append("Elevated volatility")
        if info.get("debtToEquity") and info["debtToEquity"] > 150:
            risks.append("High leverage")
        if vix and vix > 20:
            risks.append("Elevated INDIAVIX")

        out.append({
            "symbol": symbol, "snap": snap, "info": info,
            "passes": passes, "rejects": rejects,
            "raw_sub": raw_sub, "reasons": reasons, "risks": risks,
        })
    return out


def _days_until(iso_date: Optional[str], run_date_ist: datetime) -> Optional[int]:
    """Return days between run date and an ISO date string; None if unparseable."""
    if not iso_date:
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            dt = datetime.strptime(iso_date, fmt)
            return (dt.date() - run_date_ist.date()).days
        except ValueError:
            continue
    return None


async def _build_score_docs(
    raw_rows: List[Dict[str, Any]], run_date: str, run_id: str,
    earnings_map: Optional[Dict[str, str]] = None,
    run_date_ist: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Hybrid-normalize sub-scores, classify trade, persist, return score docs.

    Before hybrid normalization we apply `apply_earnings_penalty` on each
    raw sub-score dict so that a stock reporting earnings inside the 7-day
    event-risk window can't be propelled into the weekly list by a
    pre-earnings momentum blip. The penalty is independent of — and
    complementary to — the hard earnings-exclusion filter in
    `_select_ideas`.
    """
    earnings_map = earnings_map or {}
    if run_date_ist is None:
        run_date_ist = datetime.now(IST)

    # 1) Per-stock earnings dampening on raw sub-scores
    penalised = []
    for row in raw_rows:
        days = _days_until(earnings_map.get(row["symbol"]), run_date_ist)
        penalised.append(scoring.apply_earnings_penalty(row["raw_sub"], days))

    # 2) Universe-wide hybrid blend (absolute × percentile)
    norm_subs = scoring.normalize_subscores_universe(penalised)
    now_iso = datetime.now(timezone.utc).isoformat()
    setup_map = {"breakout": "breakout", "pullback": "pullback", "range": "accumulation",
                 "downtrend": "event-led", "neutral": "neutral"}
    out: List[Dict[str, Any]] = []

    for row, norm in zip(raw_rows, norm_subs):
        snap = row["snap"]
        conv = scoring.final_conviction(norm)
        direction, horizon_tag = scoring.classify_trade(
            conv, norm["technical"], norm["fundamental"], norm["macro_sector"],
        )
        if not row["passes"]:
            direction = "avoid"

        ed = _days_until(earnings_map.get(row["symbol"]), run_date_ist)
        doc = {
            "id": str(uuid.uuid4()), "symbol": row["symbol"], "as_of": now_iso,
            "technical": round(norm["technical"], 2), "fundamental": round(norm["fundamental"], 2),
            "valuation": round(norm["valuation"], 2), "ownership": round(norm["ownership"], 2),
            "analyst": round(norm["analyst"], 2), "event_news": round(norm["event_news"], 2),
            "macro_sector": round(norm["macro_sector"], 2),
            "raw_sub": {k: round(float(v), 2) for k, v in row["raw_sub"].items()},
            "conviction": conv, "direction": direction, "horizon_tag": horizon_tag,
            "reasons": row["reasons"][:10], "risks": row["risks"][:6],
            "setup_type": setup_map.get(snap.get("setup") or "neutral", "neutral"),
            "sector": snap["sector"], "name": snap["name"], "last_close": snap["last_close"],
            "passes_filters": row["passes"], "filter_rejects": row["rejects"],
            "run_date": run_date, "report_run_id": run_id,
            "earnings_penalty_applied": ed is not None and ed <= scoring.EARNINGS_PENALTY_WINDOW_DAYS,
            "earnings_in_days": ed,
        }
        await scores_col.insert_one(doc)
        out.append(doc)
    return out


def _select_ideas(
    scores: List[Dict[str, Any]], snapshots: List[Dict[str, Any]], run_id: str,
    earnings_map: Dict[str, str], run_date_ist: datetime,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Apply strict trade rules + earnings-calendar exclusion.

    Returns (weekly_ideas, monthly_ideas, excluded).
    `excluded` contains stocks that *would have* qualified on pure scoring but
    were filtered out because earnings fall inside the holding horizon. This
    surfaces transparency in the UI instead of silently dropping them.
    """
    snap_map = {s["symbol"]: s for s in snapshots}
    excluded: List[Dict[str, Any]] = []

    def _earnings_days(sym: str) -> Optional[int]:
        return _days_until(earnings_map.get(sym), run_date_ist)

    def _qualifies_weekly(s):
        return s["passes_filters"] and s["conviction"] >= 72 and s["technical"] >= 70

    def _qualifies_monthly(s):
        return (s["passes_filters"] and s["conviction"] >= 75
                and s["fundamental"] >= 70 and s["macro_sector"] >= 65)

    weekly_qual, monthly_qual = [], []
    for s in scores:
        w_ok, m_ok = _qualifies_weekly(s), _qualifies_monthly(s)
        if not (w_ok or m_ok):
            continue
        ed = _earnings_days(s["symbol"])
        # Record anything we're excluding due to earnings — user-visible transparency
        reason = None
        if w_ok and ed is not None and ed <= _WEEKLY_HOLD_DAYS:
            reason = f"Weekly blocked: earnings in {ed}d (needs > {_WEEKLY_HOLD_DAYS}d)"
        elif m_ok and ed is not None and ed <= _MONTHLY_HOLD_DAYS:
            reason = f"Monthly blocked: earnings in {ed}d (needs > {_MONTHLY_HOLD_DAYS}d)"

        if reason:
            excluded.append({
                "symbol": s["symbol"], "name": s["name"], "sector": s["sector"],
                "conviction": s["conviction"],
                "technical": s["technical"], "fundamental": s["fundamental"],
                "macro_sector": s["macro_sector"],
                "would_qualify": [h for h, ok in (("weekly", w_ok), ("monthly", m_ok)) if ok],
                "next_earnings": earnings_map.get(s["symbol"]),
                "earnings_in_days": ed,
                "exclusion_reason": reason,
            })
            continue

        if w_ok:
            weekly_qual.append(s)
        if m_ok:
            monthly_qual.append(s)

    weekly_qual.sort(key=lambda x: x["conviction"], reverse=True)
    monthly_qual.sort(key=lambda x: x["conviction"], reverse=True)
    excluded.sort(key=lambda x: x["conviction"], reverse=True)

    def _mk(score_doc, horizon):
        snap = snap_map.get(score_doc["symbol"], {})
        levels = scoring.entry_stop_target(
            snap.get("last_close") or 100.0, snap.get("atr_14"),
            score_doc["direction"], horizon,
        )
        extras = {}
        ed = _earnings_days(score_doc["symbol"])
        if ed is not None:
            extras["earnings_in_days"] = ed
            extras["next_earnings"] = earnings_map.get(score_doc["symbol"])
        return {
            "id": str(uuid.uuid4()), "report_run_id": run_id,
            "symbol": score_doc["symbol"], "name": score_doc["name"], "sector": score_doc["sector"],
            "direction": score_doc["direction"], "horizon": horizon,
            "setup_type": score_doc["setup_type"], "conviction": score_doc["conviction"],
            **levels,
            "reasons": score_doc["reasons"][:6], "risks": score_doc["risks"][:4],
            "sub_scores": {k: score_doc[k] for k in (
                "technical", "fundamental", "valuation", "ownership",
                "analyst", "event_news", "macro_sector",
            )},
            **extras,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    return (
        [_mk(s, "weekly") for s in weekly_qual[:8]],
        [_mk(s, "monthly") for s in monthly_qual[:8]],
        excluded[:20],
    )


async def _attach_rationales(
    ideas: List[Dict[str, Any]], context: Dict[str, Any], skip_llm: bool,
) -> None:
    """Fill each idea's `rationale` field with a Claude-generated 3-5 sentence
    justification citing the specific data points that make it a good bet.
    When `skip_llm` is true (admin-triggered test runs), a deterministic
    fallback rationale is produced from the collected sub-scores + reasons."""
    if not ideas:
        return
    if skip_llm:
        for i in ideas:
            i["rationale"] = sentiment._fallback_rationale(i)
        return
    results = await asyncio.gather(
        *[sentiment.generate_idea_rationale(i, context) for i in ideas],
        return_exceptions=True,
    )
    for i, res in zip(ideas, results):
        if isinstance(res, Exception) or not isinstance(res, str) or not res.strip():
            i["rationale"] = sentiment._fallback_rationale(i)
        else:
            i["rationale"] = res.strip()


def _build_context(
    run_date: str, run_id: str, ing: IngestedData,
    snapshots: List[Dict[str, Any]], scores: List[Dict[str, Any]],
    sector_breadth: Dict[str, float],
    weekly_ideas: List[Dict[str, Any]], monthly_ideas: List[Dict[str, Any]],
    universe_count: int, excluded: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    sorted_sectors = sorted(sector_breadth.items(), key=lambda x: x[1], reverse=True)
    bullish_sectors = [s for s, v in sorted_sectors[:3] if v > 0]
    cautious_sectors = [s for s, v in sorted_sectors[-3:] if v < 0]
    bearish = [s for s in scores if s["direction"] in ("bearish", "avoid") and s["conviction"] <= 40][:8]
    vix = (ing.macro.get("INDIAVIX") or {}).get("last")

    return {
        "run_date": run_date, "run_id": run_id,
        "macro": ing.macro, "sector_breadth": sector_breadth,
        "bullish_sectors": bullish_sectors, "cautious_sectors": cautious_sectors,
        "top_weekly": weekly_ideas, "top_monthly": monthly_ideas,
        "excluded_by_earnings": excluded or [],
        "bearish_watch": [{"symbol": s["symbol"], "conviction": s["conviction"]} for s in bearish],
        "universe_count": universe_count, "scored_count": len(scores),
        "fii_net_cr": ing.fii_net, "dii_net_cr": ing.dii_net,
        "flows": ing.fii_flows[:6],
        "geopolitics": [{"title": g.get("title"), "source": g.get("source")} for g in (ing.geopolitics or [])[:8]],
        "insider_highlights": [
            {"symbol": k, "promoter_buys_cr": round((v.get("promoter_buys") or 0)/1e7, 2),
             "net_buy_cr": round(((v.get("buys") or 0) - (v.get("sells") or 0))/1e7, 2),
             "n": v["n"]}
            for k, v in ing.insider_map.items()
            if (v.get("promoter_buys") or 0) > 0 or abs((v.get("buys") or 0) - (v.get("sells") or 0)) > 1e7
        ][:10],
        "sector_indices": [
            {k: r[k] for k in ("index", "last", "change_pct", "pe", "pb") if k in r}
            for r in ing.sector_indices[:25]
        ],
        "commodity_impact": ing.commodity_sector,
        "upcoming_actions_total": sum((len(v) for v in ing.corp_actions_map.values()), 0),
        "geo_events": len(ing.geopolitics),
        "fred_snapshot": {k: v for k, v in ing.fred_data.items() if v} if ing.fred_data else {},
        "earnings_calendar_count": len(ing.financial_results_map),
        "risks": [
            f"INDIAVIX at {vix:.1f}" if vix else "Volatility regime",
            (f"FII {'net-buy' if (ing.fii_net or 0) > 0 else 'net-sell'} ₹{abs(ing.fii_net or 0):.0f} Cr"
             if ing.fii_net is not None else "FII flow dependency"),
            "Global macro overhang",
        ],
    }


# ---------------------------------------------------------------------------
# Main pipeline entrypoint
# ---------------------------------------------------------------------------
async def generate_report(triggered_by: str = "scheduler", skip_llm: bool = False) -> Dict[str, Any]:
    import time as _time
    run_date = _today_ist_str()
    run_id = str(uuid.uuid4())
    started = datetime.now(timezone.utc)
    t_start = _time.monotonic()
    stage_timings: Dict[str, float] = {}

    await report_runs_col.insert_one({
        "id": run_id, "run_date": run_date, "started_at": started.isoformat(),
        "status": "running", "triggered_by": triggered_by, "summary": {}, "narrative": "",
    })

    try:
        universe = await _fetch_universe()
        if not universe:
            raise RuntimeError("Stock universe empty. Seed it first.")

        # ============================================================
        # STAGE 1 — Market-wide ingest (cheap) + bhavcopy prefilter +
        #            batched OHLC for survivors + lightweight ranking
        # ============================================================
        t0 = _time.monotonic()
        ing = await ingest_stage1_market_wide(run_id)

        # Prefilter on bhavcopy gates (price / turnover / delivery)
        prefilter_pool = prefilter.prefilter_by_bhavcopy(universe, ing.bhav_map)
        # Graceful fallback: if NSE bhavcopy is unavailable (HTTP 403 / outage)
        # we lose our cheap liquidity gate. Rather than collapsing to zero
        # candidates we restrict to the curated large-cap subset so the daily
        # report still runs end-to-end on a known-good universe.
        bhav_available = bool(ing.bhav_map)
        fallback_engaged = False
        if not prefilter_pool:
            from stock_universe import UNIVERSE as CURATED
            curated_syms = {u["symbol"] for u in CURATED}
            prefilter_pool = [u for u in universe if u.get("symbol") in curated_syms]
            fallback_engaged = True
            logger.warning(
                "Funnel | bhavcopy unavailable (rows=%s) — falling back to curated universe (n=%s)",
                len(ing.bhav_map), len(prefilter_pool),
            )
        logger.info(
            "Funnel | universe=%s prefilter_pool=%s (bhavcopy_available=%s)",
            len(universe), len(prefilter_pool), bhav_available,
        )

        # Pull OHLC ONLY for the prefilter survivors (still ~600-900 names)
        await ingest_stage1_ohlc(ing, prefilter_pool)
        if ing.macro.get("NIFTY") and ing.macro["NIFTY"].get("history"):
            ing.nifty_series = pd.Series(
                [h["close"] for h in ing.macro["NIFTY"]["history"]]
            )

        # Build snapshots for everything that came back with valid OHLC
        snapshots_lite = _build_snapshots(prefilter_pool, ing)
        logger.info("Funnel | snapshots_built=%s", len(snapshots_lite))

        # Stage-1 lightweight ranking → top ~200
        universe_by_sym = {u["symbol"]: u for u in universe}
        for s in snapshots_lite:
            u = universe_by_sym.get(s["symbol"], {})
            s["sector"] = u.get("sector") or s.get("sector") or "Other"
            s["name"] = u.get("name") or s.get("name") or s["symbol"]
        shortlisted, lite_rank_rows = prefilter.rank_and_shortlist(
            snapshots_lite, universe_by_sym, top_n=200,
        )
        logger.info("Funnel | shortlisted=%s (top of %s ranked)",
                    len(shortlisted), len(lite_rank_rows))

        # Save snapshots (only the shortlisted ones — others are noise to scoring)
        shortlisted_syms = {u["symbol"] for u in shortlisted}
        snapshots = [s for s in snapshots_lite if s["symbol"] in shortlisted_syms]
        await _persist_snapshots(snapshots)
        sector_breadth = _compute_sector_breadth(snapshots)
        stage_timings["stage1_seconds"] = round(_time.monotonic() - t0, 1)

        # ============================================================
        # STAGE 2 — Deep ingest (info, FMP, shareholding, news, etc.)
        #            ONLY on shortlisted candidates
        # ============================================================
        t0 = _time.monotonic()
        await ingest_stage2_deep(ing, shortlisted, run_id)

        info_cache = await _fetch_info_cache(shortlisted, len(shortlisted))
        news_sentiment = await _fetch_news_sentiment(
            snapshots, shortlisted, run_date, skip_llm,
            rss_by_symbol=ing.news_by_symbol,
        )
        stage_timings["stage2_seconds"] = round(_time.monotonic() - t0, 1)

        # ============================================================
        # STAGE 3 — Strict scoring + idea selection on the deep-scanned 200
        # ============================================================
        t0 = _time.monotonic()
        pe_by, pb_by, ev_by = _build_sector_peer_arrays(
            snapshots, universe_by_sym, info_cache, ing.fmp_data,
        )
        raw_rows = _compute_raw_scores(
            snapshots, ing, info_cache, news_sentiment,
            universe_by_sym, sector_breadth, pe_by, pb_by, ev_by,
        )
        scores = await _build_score_docs(
            raw_rows, run_date, run_id,
            earnings_map=ing.financial_results_map,
            run_date_ist=datetime.now(IST),
        )

        run_date_ist = datetime.now(IST)
        weekly_ideas, monthly_ideas, excluded = _select_ideas(
            scores, snapshots, run_id, ing.financial_results_map, run_date_ist,
        )
        stage_timings["stage3_seconds"] = round(_time.monotonic() - t0, 1)

        # 7) CONTEXT + per-idea RATIONALES + NARRATIVE
        ctx_draft = _build_context(
            run_date, run_id, ing, snapshots, scores, sector_breadth,
            weekly_ideas, monthly_ideas, len(universe), excluded,
        )
        await _attach_rationales(weekly_ideas + monthly_ideas, ctx_draft, skip_llm)

        if weekly_ideas:
            await ideas_col.insert_many([dict(x) for x in weekly_ideas])
        if monthly_ideas:
            await ideas_col.insert_many([dict(x) for x in monthly_ideas])
        for x in weekly_ideas + monthly_ideas:
            x.pop("_id", None)

        # Re-build context with rationale-enriched ideas so the narrative can
        # incorporate them.
        context = _build_context(
            run_date, run_id, ing, snapshots, scores, sector_breadth,
            weekly_ideas, monthly_ideas, len(universe), excluded,
        )
        # Funnel telemetry — most important transparency artefact.
        # `connector_failures` is pulled from `ingestion_runs` for THIS run so
        # the dashboard can flag silent ingestion outages.
        try:
            from db import ingestion_runs_col
            failed = await ingestion_runs_col.find(
                {"run_id": run_id, "status": "failed"},
                {"_id": 0, "connector": 1, "stage": 1, "error": 1},
            ).to_list(50)
        except Exception:  # noqa: BLE001
            failed = []
        funnel_stats = {
            "universe_total": len(universe),
            "prefilter_pool": len(prefilter_pool),
            "ohlc_returned": len(ing.hist),
            "ranked": len(lite_rank_rows),
            "shortlisted": len(shortlisted),
            "scored": len(scores),
            "weekly_ideas": len(weekly_ideas),
            "monthly_ideas": len(monthly_ideas),
            "excluded_by_earnings": len(excluded),
            "bhavcopy_available": bhav_available,
            "fallback_engaged": fallback_engaged,
            "connector_failures": len(failed),
            "failed_connectors": [{"connector": f.get("connector"),
                                   "stage": f.get("stage"),
                                   "error": (f.get("error") or "")[:160]}
                                  for f in failed[:10]],
            "total_seconds": round(_time.monotonic() - t_start, 1),
            **stage_timings,
        }
        context["funnel"] = funnel_stats
        narrative = (sentiment._fallback_narrative(context) if skip_llm
                     else await sentiment.generate_report_narrative(context))
        context["narrative"] = narrative

        # 8) PERSIST
        await report_runs_col.update_one(
            {"id": run_id},
            {"$set": {
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "status": "success",
                "summary": {k: v for k, v in context.items() if k != "macro"},
                "macro_snapshot": {k: {kk: vv for kk, vv in (v or {}).items() if kk != "history"}
                                   for k, v in ing.macro.items()},
                "narrative": narrative,
                "funnel": funnel_stats,
                # Full lightweight rank table (capped) for the dashboard drilldown
                "lite_rank_top": lite_rank_rows[:300],
            }},
        )

        # 9) DELIVER (Telegram + Gmail)
        await _deliver_to_all_users(run_id, run_date, context)

        doc = await report_runs_col.find_one({"id": run_id}, {"_id": 0})
        return doc or {"id": run_id, "status": "success"}

    except Exception as e:  # noqa: BLE001
        logger.exception("Report generation failed")
        await report_runs_col.update_one(
            {"id": run_id},
            {"$set": {"status": "failed", "error": str(e),
                      "finished_at": datetime.now(timezone.utc).isoformat()}},
        )
        return {"id": run_id, "status": "failed", "error": str(e)}


async def _deliver_to_all_users(run_id: str, run_date: str, context: Dict[str, Any]) -> None:
    users = await users_col.find({}, {"_id": 0, "password_hash": 0}).to_list(1000)
    tg_text = delivery_telegram.format_telegram_summary(context)
    html = delivery_email.render_email_html(context)

    for u in users:
        prefs = await preferences_col.find_one({"user_id": u["id"]}, {"_id": 0}) or {}

        if prefs.get("telegram_alerts", True):
            chat_id = prefs.get("telegram_chat_id") or ""
            res = await delivery_telegram.send_telegram(chat_id, tg_text)
            await deliveries_col.insert_one({
                "id": str(uuid.uuid4()), "report_run_id": run_id, "user_id": u["id"],
                "channel": "telegram", "recipient": chat_id or "(unset)",
                "status": res.get("status", "failed"), "attempts": 1,
                "error": res.get("error"), "response_meta": {"dry_run": res.get("dry_run")},
                "created_at": datetime.now(timezone.utc).isoformat(), "run_date": run_date,
            })

        if prefs.get("email_alerts", True):
            res = await delivery_email.send_email(
                to_email=u["email"],
                subject=f"Market Pulse India — Daily Brief {run_date}",
                html_body=html,
            )
            await deliveries_col.insert_one({
                "id": str(uuid.uuid4()), "report_run_id": run_id, "user_id": u["id"],
                "channel": "email", "recipient": u["email"],
                "status": res.get("status", "failed"), "attempts": 1,
                "error": res.get("error"), "response_meta": {"dry_run": res.get("dry_run")},
                "created_at": datetime.now(timezone.utc).isoformat(), "run_date": run_date,
            })
