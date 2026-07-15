"""Data ingestion orchestrator.

`ingest_all(universe)` runs every connector the daily report needs in parallel,
persists each payload to Mongo, and returns a typed `IngestedData` dataclass
that the scoring pipeline consumes.

Keeping all ingestion here means `services/report.py` becomes pure orchestration
(snapshots → scores → ideas → narrative) and each connector block is independently
testable and swappable.

Every block is wrapped via `_run_tracked()` so we record per-source latency,
status, and records-fetched into `ingestion_runs` for an ingestion-health
dashboard.
"""
from __future__ import annotations
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional

import pandas as pd

from connectors.market_data import EquityHistoryConnector, MacroConnector
from connectors.nse import (
    NSEBhavcopyConnector, NSEFIIDIIConnector, NSEInsiderConnector, GDELTConnector,
    NSESectorIndicesConnector, NSECorpAnnouncementsConnector, NSECorpActionsConnector,
    NSEShareholdingConnector, NSEFinancialResultsConnector,
)
from connectors.fmp import FMPConnector
from connectors.fred import FREDConnector
from connectors.rss_news import RSSNewsConnector
from db import (
    bhavcopy_col, fii_dii_col, insider_col, gdelt_col, sector_indices_col,
    corp_ann_col, corp_actions_col, shareholding_col_new, fmp_col, fred_col,
    fin_results_col, rss_news_col, ingestion_runs_col,
)
from services import commodity_mapping

logger = logging.getLogger(__name__)


@dataclass
class IngestedData:
    """Everything scoring needs in one typed bag."""
    # Market data
    macro: Dict[str, Any] = field(default_factory=dict)
    hist: Dict[str, pd.DataFrame] = field(default_factory=dict)
    nifty_series: Optional[pd.Series] = None
    # NSE core
    bhav_map: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    fii_flows: List[Dict[str, Any]] = field(default_factory=list)
    fii_net: Optional[float] = None
    dii_net: Optional[float] = None
    insider_map: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    geopolitics: List[Dict[str, Any]] = field(default_factory=list)
    sector_indices: List[Dict[str, Any]] = field(default_factory=list)
    sector_pe: Dict[str, float] = field(default_factory=dict)
    corp_ann: List[Dict[str, Any]] = field(default_factory=list)
    corp_actions_map: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    shareholding: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    shareholding_delta: Dict[str, Dict[str, float]] = field(default_factory=dict)  # sym -> {promoter_delta, fii_delta, dii_delta}
    financial_results_map: Dict[str, str] = field(default_factory=dict)   # symbol -> next bm_date ISO
    # Optional
    fmp_data: Dict[str, Any] = field(default_factory=dict)
    fred_data: Dict[str, Any] = field(default_factory=dict)
    # Multi-source RSS news
    rss_news: List[Dict[str, Any]] = field(default_factory=list)
    news_by_symbol: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    # Derived
    commodity_sector: Dict[str, float] = field(default_factory=dict)
    # Telemetry
    telemetry: List[Dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Individual ingestion blocks (each one is small, focused, and testable)
# ---------------------------------------------------------------------------
async def _ingest_macro(data: IngestedData) -> None:
    res = await MacroConnector().run()
    data.macro = res.get("data") or {}
    nifty_hist = data.macro.get("NIFTY")
    if nifty_hist and nifty_hist.get("history"):
        data.nifty_series = pd.Series([h["close"] for h in nifty_hist["history"]])


async def _ingest_equities(data: IngestedData, universe: List[Dict[str, Any]]) -> None:
    yf_symbols = [u["yf_symbol"] for u in universe]
    res = await EquityHistoryConnector().run(tickers=yf_symbols, period="1y", interval="1d")
    data.hist = res.get("data") or {}


async def _ingest_bhavcopy(data: IngestedData) -> None:
    try:
        res = await NSEBhavcopyConnector().run()
        payload = res.get("data") or {}
        rows = payload.get("rows") if isinstance(payload, dict) else []
        if not rows:
            return
        data.bhav_map = {r["symbol"]: r for r in rows}
        as_of = payload.get("as_of")
        await bhavcopy_col.delete_many({"as_of": as_of})
        await bhavcopy_col.insert_many([
            dict({**r, "as_of": as_of, "ingested_at": datetime.now(timezone.utc).isoformat()})
            for r in rows
        ])
    except Exception as e:  # noqa: BLE001
        logger.warning("Bhavcopy fetch failed: %s", e)


async def _ingest_fii_dii(data: IngestedData) -> None:
    try:
        res = await NSEFIIDIIConnector().run()
        flows = res.get("data") or []
        data.fii_flows = flows
        if flows:
            await fii_dii_col.insert_many([
                dict({**r, "ingested_at": datetime.now(timezone.utc).isoformat()}) for r in flows
            ])
        for r in flows:
            cat = (r.get("category") or "").upper()
            if "FII" in cat or "FPI" in cat:
                data.fii_net = r.get("net_value")
            elif cat == "DII":
                data.dii_net = r.get("net_value")
    except Exception as e:  # noqa: BLE001
        logger.warning("FII/DII fetch failed: %s", e)


async def _ingest_insider(data: IngestedData) -> None:
    try:
        res = await NSEInsiderConnector().run(days_back=30)
        rows = res.get("data") or []
        if rows:
            await insider_col.insert_many([
                dict({**r, "ingested_at": datetime.now(timezone.utc).isoformat()}) for r in rows
            ])
        agg: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            sym = (r.get("symbol") or "").upper()
            if not sym:
                continue
            d = agg.setdefault(sym, {"buys": 0, "sells": 0, "n": 0, "promoter_buys": 0})
            tx = (r.get("tx_type") or "").lower()
            v = r.get("value") or 0
            d["n"] += 1
            if "purchase" in tx or "buy" in tx:
                d["buys"] += v
                if "promoter" in (r.get("category") or "").lower():
                    d["promoter_buys"] += v
            elif "sale" in tx or "sell" in tx:
                d["sells"] += v
        data.insider_map = agg
    except Exception as e:  # noqa: BLE001
        logger.warning("Insider fetch failed: %s", e)


async def _ingest_gdelt(data: IngestedData) -> None:
    try:
        res = await GDELTConnector().run()
        rows = res.get("data") or []
        data.geopolitics = rows
        if rows:
            await gdelt_col.insert_many([
                dict({**r, "ingested_at": datetime.now(timezone.utc).isoformat()})
                for r in rows[:20]
            ])
    except Exception as e:  # noqa: BLE001
        logger.warning("GDELT fetch failed: %s", e)


async def _ingest_sector_indices(data: IngestedData) -> None:
    try:
        res = await NSESectorIndicesConnector().run()
        rows = res.get("data") or []
        data.sector_indices = rows
        if rows:
            as_of = datetime.now(timezone.utc).isoformat()
            await sector_indices_col.delete_many({})
            await sector_indices_col.insert_many([dict({**r, "as_of": as_of}) for r in rows])
            for r in rows:
                if r.get("index") and r.get("pe") is not None:
                    data.sector_pe[r["index"]] = r["pe"]
    except Exception as e:  # noqa: BLE001
        logger.warning("Sector indices fetch failed: %s", e)


async def _ingest_corp_ann(data: IngestedData) -> None:
    try:
        res = await NSECorpAnnouncementsConnector().run()
        rows = res.get("data") or []
        data.corp_ann = rows
        if rows:
            await corp_ann_col.insert_many([
                dict({**r, "ingested_at": datetime.now(timezone.utc).isoformat()})
                for r in rows[:100]
            ])
    except Exception as e:  # noqa: BLE001
        logger.warning("Corp announcements fetch failed: %s", e)


async def _ingest_corp_actions(data: IngestedData) -> None:
    try:
        res = await NSECorpActionsConnector().run()
        rows = res.get("data") or []
        if rows:
            await corp_actions_col.insert_many([
                dict({**r, "ingested_at": datetime.now(timezone.utc).isoformat()}) for r in rows
            ])
        for r in rows:
            sym = r.get("symbol")
            if sym:
                data.corp_actions_map.setdefault(sym, []).append(r)
    except Exception as e:  # noqa: BLE001
        logger.warning("Corp actions fetch failed: %s", e)


async def _ingest_shareholding(data: IngestedData, universe: List[Dict[str, Any]]) -> None:
    """Full-universe (not top-15) quarterly shareholding pull. Persists each
    snapshot and computes delta vs previous quarter per symbol."""
    try:
        syms = [u["symbol"] for u in universe]
        res = await NSEShareholdingConnector().run(symbols=syms)
        payload = res.get("data") or {}
        if not isinstance(payload, dict):
            return
        data.shareholding = payload
        now_iso = datetime.now(timezone.utc).isoformat()
        for sym, rows in payload.items():
            if not rows:
                continue
            await shareholding_col_new.insert_many([
                dict({**r, "ingested_at": now_iso}) for r in rows
            ])
            # Delta: first row (most recent) vs second row (previous quarter) if present
            if len(rows) >= 2:
                cur, prev = rows[0], rows[1]

                def _n(row, key):
                    v = row.get(key)
                    try:
                        return float(v) if v not in (None, "", "-") else None
                    except (TypeError, ValueError):
                        return None

                cur_p = _n(cur, "promoter_pct") or _n(cur, "promoter_holding")
                prev_p = _n(prev, "promoter_pct") or _n(prev, "promoter_holding")
                cur_f = _n(cur, "fii_pct") or _n(cur, "fii_holding")
                prev_f = _n(prev, "fii_pct") or _n(prev, "fii_holding")
                cur_d = _n(cur, "dii_pct") or _n(cur, "dii_holding")
                prev_d = _n(prev, "dii_pct") or _n(prev, "dii_holding")
                delta = {}
                if cur_p is not None and prev_p is not None:
                    delta["promoter_delta"] = round(cur_p - prev_p, 3)
                if cur_f is not None and prev_f is not None:
                    delta["fii_delta"] = round(cur_f - prev_f, 3)
                if cur_d is not None and prev_d is not None:
                    delta["dii_delta"] = round(cur_d - prev_d, 3)
                if delta:
                    data.shareholding_delta[sym] = delta
    except Exception as e:  # noqa: BLE001
        logger.warning("Shareholding fetch failed: %s", e)


async def _ingest_rss_news(data: IngestedData, universe: List[Dict[str, Any]]) -> None:
    """Multi-source RSS (ET/BS/MC/Reuters). Deduplicated + classified."""
    try:
        res = await RSSNewsConnector().run(universe=universe)
        items = res.get("data") or []
        if not items:
            return
        data.rss_news = items
        # Persist with upsert on hash id
        for it in items:
            await rss_news_col.update_one({"id": it["id"]}, {"$set": it}, upsert=True)
        # Group by symbol for downstream sentiment aggregation
        for it in items:
            for sym in it.get("matched_symbols") or []:
                data.news_by_symbol.setdefault(sym, []).append(it)
    except Exception as e:  # noqa: BLE001
        logger.warning("RSS news fetch failed: %s", e)


async def _ingest_financial_results(data: IngestedData) -> None:
    """Upcoming earnings / board meetings — keyed by symbol → earliest bm_date."""
    try:
        res = await NSEFinancialResultsConnector().run(period="Upcoming")
        rows = res.get("data") or []
        if rows:
            as_of = datetime.now(timezone.utc).isoformat()
            await fin_results_col.delete_many({"period": "Upcoming"})
            await fin_results_col.insert_many([dict({**r, "as_of": as_of}) for r in rows])
        # Build symbol -> earliest upcoming date map
        for r in rows:
            sym = (r.get("symbol") or "").upper()
            bm = r.get("bm_date")
            if not (sym and bm):
                continue
            existing = data.financial_results_map.get(sym)
            if not existing or bm < existing:
                data.financial_results_map[sym] = bm
    except Exception as e:  # noqa: BLE001
        logger.warning("Financial-results fetch failed: %s", e)


async def _ingest_fmp(data: IngestedData, universe: List[Dict[str, Any]]) -> None:
    try:
        res = await FMPConnector().run(symbols=[u["symbol"] for u in universe])
        payload = res.get("data") or {}
        if not (isinstance(payload, dict) and payload.get("data")):
            return
        data.fmp_data = payload["data"]
        rows = [
            {"symbol": s, **v, "ingested_at": datetime.now(timezone.utc).isoformat()}
            for s, v in data.fmp_data.items()
        ]
        if rows:
            await fmp_col.insert_many([dict(r) for r in rows])
    except Exception as e:  # noqa: BLE001
        logger.warning("FMP fetch failed: %s", e)


async def _ingest_fred(data: IngestedData) -> None:
    try:
        res = await FREDConnector().run()
        payload = res.get("data") or {}
        if not (isinstance(payload, dict) and payload.get("data")):
            return
        data.fred_data = payload["data"]
        for k, v in data.fred_data.items():
            await fred_col.update_one(
                {"series_id": v.get("series_id")},
                {"$set": {**v, "key": k, "ingested_at": datetime.now(timezone.utc).isoformat()}},
                upsert=True,
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("FRED fetch failed: %s", e)


# ---------------------------------------------------------------------------
# Telemetry wrapper
# ---------------------------------------------------------------------------
async def _run_tracked(
    data: IngestedData, name: str,
    coro_fn: Callable[[], Coroutine[Any, Any, Any]],
    records_getter: Callable[[], int],
) -> None:
    """Execute an ingestion block, record its telemetry into data.telemetry.
    Each block already handles its own try/except; this wrapper catches anything
    that escapes and flags the source as failed without breaking the report."""
    t0 = time.monotonic()
    status = "success"
    error: Optional[str] = None
    try:
        await coro_fn()
    except Exception as e:  # noqa: BLE001
        status = "failed"
        error = f"{type(e).__name__}: {str(e)[:160]}"
        logger.warning("Ingest block %s failed: %s", name, error)
    latency_ms = int((time.monotonic() - t0) * 1000)
    try:
        records = records_getter()
    except Exception:  # noqa: BLE001
        records = 0
    data.telemetry.append({
        "connector": name, "status": status, "records": records,
        "latency_ms": latency_ms, "error": error,
    })


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------
async def ingest_all(universe: List[Dict[str, Any]], run_id: Optional[str] = None) -> IngestedData:
    """Run every ingestion block. Macro + equities are awaited first because
    scoring has a hard dependency on them; the rest proceed concurrently and
    degrade gracefully (per-block try/except).

    NOTE: This entrypoint is preserved for backward compatibility (regression
    tests and any external callers). Production daily reports now use the
    institutional funnel via `ingest_stage1_market_wide` (Stage 1) →
    `ingest_stage2_deep` (Stage 2) so we don't blow the run-budget on the
    full ~2,000 stock universe.
    """
    data = IngestedData()
    run_id = run_id or str(uuid.uuid4())
    started_iso = datetime.now(timezone.utc).isoformat()

    # Hard-required dependencies first
    await asyncio.gather(
        _run_tracked(data, "macro", lambda: _ingest_macro(data), lambda: len(data.macro)),
        _run_tracked(data, "equities", lambda: _ingest_equities(data, universe), lambda: len(data.hist)),
    )

    # Everything else runs in parallel; each block is fault-isolated.
    await asyncio.gather(
        _run_tracked(data, "bhavcopy", lambda: _ingest_bhavcopy(data), lambda: len(data.bhav_map)),
        _run_tracked(data, "fii_dii", lambda: _ingest_fii_dii(data), lambda: len(data.fii_flows)),
        _run_tracked(data, "insider", lambda: _ingest_insider(data), lambda: len(data.insider_map)),
        _run_tracked(data, "gdelt", lambda: _ingest_gdelt(data), lambda: len(data.geopolitics)),
        _run_tracked(data, "sector_indices", lambda: _ingest_sector_indices(data), lambda: len(data.sector_indices)),
        _run_tracked(data, "corp_announcements", lambda: _ingest_corp_ann(data), lambda: len(data.corp_ann)),
        _run_tracked(data, "corp_actions", lambda: _ingest_corp_actions(data), lambda: len(data.corp_actions_map)),
        _run_tracked(data, "shareholding", lambda: _ingest_shareholding(data, universe), lambda: len(data.shareholding)),
        _run_tracked(data, "financial_results", lambda: _ingest_financial_results(data), lambda: len(data.financial_results_map)),
        _run_tracked(data, "fmp", lambda: _ingest_fmp(data, universe), lambda: len(data.fmp_data)),
        _run_tracked(data, "fred", lambda: _ingest_fred(data), lambda: len(data.fred_data)),
        _run_tracked(data, "rss_news", lambda: _ingest_rss_news(data, universe), lambda: len(data.rss_news)),
    )

    # Derived: commodity -> sector impact map (depends on macro)
    data.commodity_sector = commodity_mapping.sector_impact_scores(data.macro)

    # Persist run-level telemetry
    try:
        await ingestion_runs_col.insert_many([
            {**t, "run_id": run_id, "started_at": started_iso,
             "finished_at": datetime.now(timezone.utc).isoformat()}
            for t in data.telemetry
        ])
    except Exception as e:  # noqa: BLE001
        logger.warning("Telemetry persist failed: %s", e)

    return data


# ---------------------------------------------------------------------------
# Institutional funnel — split entrypoints (Stage 1 + Stage 2)
# ---------------------------------------------------------------------------
async def ingest_stage1_market_wide(run_id: str) -> IngestedData:
    """Stage 1: cheap, market-wide ingest with NO per-stock HTTP calls.

    Pulls only the global / single-call sources:
        - macro (one yfinance batch, ~21 tickers)
        - bhavcopy (one HTTP call, ~2,000 EOD rows)
        - FII/DII flows (one call)
        - sector indices (one call)
        - GDELT geopolitics (one call)
        - FRED macro (one call)

    Per-stock OHLC is NOT fetched here — Stage 1 prefilter narrows the
    universe first using bhavcopy gates, then `ingest_stage1_ohlc` pulls
    OHLC ONLY for the survivors.
    """
    data = IngestedData()
    started_iso = datetime.now(timezone.utc).isoformat()
    await asyncio.gather(
        _run_tracked(data, "macro", lambda: _ingest_macro(data), lambda: len(data.macro)),
        _run_tracked(data, "bhavcopy", lambda: _ingest_bhavcopy(data), lambda: len(data.bhav_map)),
        _run_tracked(data, "fii_dii", lambda: _ingest_fii_dii(data), lambda: len(data.fii_flows)),
        _run_tracked(data, "sector_indices", lambda: _ingest_sector_indices(data), lambda: len(data.sector_indices)),
        _run_tracked(data, "gdelt", lambda: _ingest_gdelt(data), lambda: len(data.geopolitics)),
        _run_tracked(data, "fred", lambda: _ingest_fred(data), lambda: len(data.fred_data)),
    )
    data.commodity_sector = commodity_mapping.sector_impact_scores(data.macro)
    # Persist telemetry tagged with stage
    try:
        await ingestion_runs_col.insert_many([
            {**t, "run_id": run_id, "stage": "stage1", "started_at": started_iso,
             "finished_at": datetime.now(timezone.utc).isoformat()}
            for t in data.telemetry
        ])
    except Exception as e:  # noqa: BLE001
        logger.warning("Telemetry persist failed (stage1): %s", e)
    data.telemetry = []   # reset so stage 2 telemetry is recorded separately
    return data


async def ingest_stage1_ohlc(data: IngestedData, prefilter_pool: List[Dict[str, Any]]) -> None:
    """Download 1-year daily OHLC for ONLY the bhavcopy-prefilter survivors.
    The chunked downloader inside `EquityHistoryConnector` handles rate
    limiting (20-stock batches with a 200 ms sleep)."""
    if not prefilter_pool:
        return
    started = datetime.now(timezone.utc).isoformat()
    t0 = time.monotonic()
    try:
        await _ingest_equities(data, prefilter_pool)
        status, error = "success", None
    except Exception as e:  # noqa: BLE001
        status, error = "failed", f"{type(e).__name__}: {str(e)[:160]}"
        logger.warning("Stage 1 OHLC fetch failed: %s", error)
    data.telemetry.append({
        "connector": "equities_stage1", "status": status,
        "records": len(data.hist), "latency_ms": int((time.monotonic() - t0) * 1000),
        "error": error, "stage": "stage1",
    })
    # Best-effort telemetry persist
    try:
        await ingestion_runs_col.insert_many([
            {**t, "started_at": started,
             "finished_at": datetime.now(timezone.utc).isoformat()}
            for t in data.telemetry if t["connector"] == "equities_stage1"
        ])
    except Exception:  # noqa: BLE001
        pass
    data.telemetry = [t for t in data.telemetry if t["connector"] != "equities_stage1"]


async def ingest_stage2_deep(
    data: IngestedData, shortlisted: List[Dict[str, Any]], run_id: str,
) -> None:
    """Stage 2: per-symbol heavy ingest, ONLY on shortlisted candidates.

    The expensive blocks live here because each one does per-stock HTTP work
    or LLM calls:
        - shareholding (one NSE call per symbol)
        - FMP fundamentals (one paid-API call per symbol)
        - RSS news matching (cheap, but classified per symbol)
        - corp announcements + actions + insider (global lists, but persisted
          here because the deep snapshot is what consumes them)
        - financial results calendar
    """
    started_iso = datetime.now(timezone.utc).isoformat()
    await asyncio.gather(
        _run_tracked(data, "insider", lambda: _ingest_insider(data), lambda: len(data.insider_map)),
        _run_tracked(data, "corp_announcements", lambda: _ingest_corp_ann(data), lambda: len(data.corp_ann)),
        _run_tracked(data, "corp_actions", lambda: _ingest_corp_actions(data), lambda: len(data.corp_actions_map)),
        _run_tracked(data, "shareholding",
                     lambda: _ingest_shareholding(data, shortlisted),
                     lambda: len(data.shareholding)),
        _run_tracked(data, "financial_results",
                     lambda: _ingest_financial_results(data),
                     lambda: len(data.financial_results_map)),
        _run_tracked(data, "fmp",
                     lambda: _ingest_fmp(data, shortlisted),
                     lambda: len(data.fmp_data)),
        _run_tracked(data, "rss_news",
                     lambda: _ingest_rss_news(data, shortlisted),
                     lambda: len(data.rss_news)),
    )
    try:
        await ingestion_runs_col.insert_many([
            {**t, "run_id": run_id, "stage": "stage2", "started_at": started_iso,
             "finished_at": datetime.now(timezone.utc).isoformat()}
            for t in data.telemetry
        ])
    except Exception as e:  # noqa: BLE001
        logger.warning("Telemetry persist failed (stage2): %s", e)
    data.telemetry = []
