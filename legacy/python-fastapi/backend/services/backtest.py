"""Backtest harness for historical trade-idea hit-rate.

Given a past `report_run_id`, replays every idea on the calendar-forward price
series and measures whether entry / stop / target levels triggered within the
holding horizon. Produces per-trade outcomes + an aggregated run summary
(hit-rate, average return, average holding days).

Outcome enum
------------
- `hit_target`  — price reached target_low (bullish) / target_high (bearish) first
- `hit_stop`    — price reached stop_loss first
- `time_stop`   — horizon exhausted; closed at last available close
- `no_entry`    — never entered the entry band within `entry_window_days`
- `no_data`     — yfinance returned no bars after the idea date

Price downloads use yfinance in a thread pool. The harness is deliberately
offline-safe (per-symbol try/except) so one bad ticker cannot abort an entire
run.
"""
from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pandas as pd

from db import (
    backtest_runs_col, backtest_trades_col, ideas_col,
    report_runs_col, stock_universe_col,
)

logger = logging.getLogger(__name__)

# Horizon → trading-day holding window
HORIZON_DAYS = {"weekly": 7, "monthly": 30, "both": 30}
# How long to wait for entry-band fill before calling it a no-entry
ENTRY_WINDOW_DAYS = 3


async def _fetch_history(yf_symbol: str, start: str, end: str) -> Optional[pd.DataFrame]:
    """Download daily OHLC in a thread pool. Returns None on failure / empty."""
    import yfinance as yf
    loop = asyncio.get_running_loop()

    def _get():
        try:
            df = yf.Ticker(yf_symbol).history(
                start=start, end=end, interval="1d", auto_adjust=False,
            )
            if df is None or df.empty:
                return None
            df = df.rename(columns={"Open": "open", "High": "high",
                                    "Low": "low", "Close": "close"})
            return df[["open", "high", "low", "close"]].copy()
        except Exception as e:  # noqa: BLE001
            logger.warning("yfinance history failed for %s: %s", yf_symbol, e)
            return None

    return await loop.run_in_executor(None, _get)


def _simulate_trade(
    df: pd.DataFrame, idea: Dict[str, Any], horizon_days: int,
) -> Dict[str, Any]:
    """Run the entry / stop / target walk. `df` is indexed chronologically."""
    direction = idea.get("direction", "bullish")
    entry_low = float(idea.get("entry_low") or 0)
    entry_high = float(idea.get("entry_high") or 0)
    stop_loss = float(idea.get("stop_loss") or 0)
    t_low = float(idea.get("target_low") or 0)
    t_high = float(idea.get("target_high") or 0)

    if df is None or df.empty:
        return {"outcome": "no_data"}

    entry_idx: Optional[int] = None
    entry_price: Optional[float] = None

    # 1) Find entry: first bar whose daily range overlaps the entry band
    for i in range(min(ENTRY_WINDOW_DAYS, len(df))):
        row = df.iloc[i]
        lo, hi = float(row["low"]), float(row["high"])
        if lo <= entry_high and hi >= entry_low:
            entry_idx = i
            # assume entry at the band midpoint (or open if within band)
            op = float(row["open"])
            if entry_low <= op <= entry_high:
                entry_price = op
            else:
                entry_price = round((entry_low + entry_high) / 2, 2)
            break

    if entry_idx is None or entry_price is None:
        return {"outcome": "no_entry"}

    # 2) Walk forward from the bar AFTER entry
    end_idx = min(len(df) - 1, entry_idx + horizon_days)
    for j in range(entry_idx + 1, end_idx + 1):
        row = df.iloc[j]
        lo, hi = float(row["low"]), float(row["high"])
        if direction == "bullish":
            if lo <= stop_loss:
                return _outcome("hit_stop", entry_price, stop_loss, j - entry_idx, row, df, entry_idx)
            if hi >= t_low:
                return _outcome("hit_target", entry_price, t_low, j - entry_idx, row, df, entry_idx)
        elif direction == "bearish":
            if hi >= stop_loss:
                return _outcome("hit_stop", entry_price, stop_loss, j - entry_idx, row, df, entry_idx)
            if lo <= t_high:
                return _outcome("hit_target", entry_price, t_high, j - entry_idx, row, df, entry_idx)

    # 3) Horizon exhausted → close at last available bar
    last = df.iloc[end_idx]
    exit_price = float(last["close"])
    return _outcome("time_stop", entry_price, exit_price, end_idx - entry_idx, last, df, entry_idx)


def _outcome(
    outcome: str, entry: float, exit_price: float, holding_days: int,
    exit_row: pd.Series, df: pd.DataFrame, entry_idx: int,
) -> Dict[str, Any]:
    ret_pct = round((exit_price - entry) / entry * 100, 3) if entry else 0.0
    entry_ts = df.index[entry_idx]
    exit_ts = exit_row.name
    return {
        "outcome": outcome, "entry_price": round(entry, 2),
        "exit_price": round(exit_price, 2),
        "holding_days": int(holding_days),
        "return_pct": ret_pct,
        "entry_date": str(entry_ts.date()) if hasattr(entry_ts, "date") else str(entry_ts),
        "exit_date": str(exit_ts.date()) if hasattr(exit_ts, "date") else str(exit_ts),
    }


async def _backtest_one_idea(
    idea: Dict[str, Any], yf_map: Dict[str, str], run_date: str,
) -> Dict[str, Any]:
    sym = idea.get("symbol", "")
    yf_sym = yf_map.get(sym) or f"{sym}.NS"
    horizon = idea.get("horizon", "weekly")
    hd = HORIZON_DAYS.get(horizon, 7)

    # Fetch history from the day after the idea was published, plus the
    # entry-window + horizon with a small buffer for weekends / holidays.
    try:
        start_dt = datetime.strptime(run_date, "%Y-%m-%d")
    except ValueError:
        return {"symbol": sym, "outcome": "no_data", "error": "bad_run_date"}
    # Start on next trading day
    start = (start_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    end = (start_dt + timedelta(days=hd + ENTRY_WINDOW_DAYS + 7)).strftime("%Y-%m-%d")

    df = await _fetch_history(yf_sym, start, end)
    if df is None or df.empty:
        return {"symbol": sym, "horizon": horizon, "outcome": "no_data"}

    sim = _simulate_trade(df, idea, hd)
    return {
        "symbol": sym, "name": idea.get("name"), "sector": idea.get("sector"),
        "direction": idea.get("direction"), "horizon": horizon,
        "conviction": idea.get("conviction"),
        "entry_low": idea.get("entry_low"), "entry_high": idea.get("entry_high"),
        "stop_loss": idea.get("stop_loss"),
        "target_low": idea.get("target_low"), "target_high": idea.get("target_high"),
        **sim,
    }


def _summarise(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    closed = [t for t in trades if t.get("outcome") in ("hit_target", "hit_stop", "time_stop")]
    wins = [t for t in closed if t.get("return_pct", 0) > 0]
    targets = [t for t in closed if t["outcome"] == "hit_target"]
    stops = [t for t in closed if t["outcome"] == "hit_stop"]
    time_stops = [t for t in closed if t["outcome"] == "time_stop"]
    no_entry = [t for t in trades if t["outcome"] == "no_entry"]
    no_data = [t for t in trades if t["outcome"] == "no_data"]
    avg_ret = (sum(t["return_pct"] for t in closed) / len(closed)) if closed else 0.0
    avg_hold = (sum(t["holding_days"] for t in closed) / len(closed)) if closed else 0.0
    hit_rate = (len(wins) / len(closed) * 100) if closed else 0.0
    target_rate = (len(targets) / len(closed) * 100) if closed else 0.0

    by_horizon: Dict[str, Dict[str, Any]] = {}
    for h in ("weekly", "monthly"):
        sub = [t for t in closed if t.get("horizon") == h]
        if sub:
            sub_wins = [t for t in sub if t.get("return_pct", 0) > 0]
            by_horizon[h] = {
                "count": len(sub),
                "hit_rate": round(len(sub_wins) / len(sub) * 100, 2),
                "avg_return_pct": round(sum(t["return_pct"] for t in sub) / len(sub), 3),
                "targets": sum(1 for t in sub if t["outcome"] == "hit_target"),
                "stops": sum(1 for t in sub if t["outcome"] == "hit_stop"),
                "time_stops": sum(1 for t in sub if t["outcome"] == "time_stop"),
            }
    return {
        "total": len(trades),
        "closed": len(closed), "no_entry": len(no_entry), "no_data": len(no_data),
        "hit_rate_pct": round(hit_rate, 2),
        "target_rate_pct": round(target_rate, 2),
        "stop_rate_pct": round(len(stops) / len(closed) * 100, 2) if closed else 0.0,
        "time_stop_rate_pct": round(len(time_stops) / len(closed) * 100, 2) if closed else 0.0,
        "avg_return_pct": round(avg_ret, 3),
        "avg_holding_days": round(avg_hold, 2),
        "by_horizon": by_horizon,
    }


async def backtest_report_run(report_run_id: str, triggered_by: str = "admin") -> Dict[str, Any]:
    """Run the backtest for every idea attached to a single report run.
    Persists trades + aggregated run summary and returns the run doc."""
    run = await report_runs_col.find_one({"id": report_run_id}, {"_id": 0})
    if not run:
        raise ValueError(f"report_run_id {report_run_id} not found")
    run_date = run.get("run_date")
    if not run_date:
        raise ValueError("report run missing run_date")

    ideas = await ideas_col.find({"report_run_id": report_run_id}, {"_id": 0}).to_list(200)
    if not ideas:
        summary = {"total": 0, "closed": 0, "hit_rate_pct": 0.0, "avg_return_pct": 0.0}
        bt_run = {
            "id": str(uuid.uuid4()), "report_run_id": report_run_id, "run_date": run_date,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "triggered_by": triggered_by, "status": "empty", "summary": summary, "trades_count": 0,
        }
        await backtest_runs_col.insert_one(dict(bt_run))
        bt_run.pop("_id", None)
        return bt_run

    universe = await stock_universe_col.find({}, {"_id": 0, "symbol": 1, "yf_symbol": 1}).to_list(500)
    yf_map = {u["symbol"]: u.get("yf_symbol") or f"{u['symbol']}.NS" for u in universe}

    # Backtest every idea in parallel (capped)
    trades_raw = await asyncio.gather(
        *[_backtest_one_idea(idea, yf_map, run_date) for idea in ideas],
        return_exceptions=True,
    )
    trades: List[Dict[str, Any]] = []
    for t in trades_raw:
        if isinstance(t, Exception):
            logger.warning("Backtest trade errored: %s", t)
            continue
        trades.append(t)

    bt_id = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()
    if trades:
        await backtest_trades_col.insert_many([
            dict({**t, "backtest_run_id": bt_id, "report_run_id": report_run_id,
                  "created_at": now_iso})
            for t in trades
        ])

    summary = _summarise(trades)
    bt_run = {
        "id": bt_id, "report_run_id": report_run_id, "run_date": run_date,
        "created_at": now_iso, "triggered_by": triggered_by,
        "status": "success", "summary": summary, "trades_count": len(trades),
    }
    await backtest_runs_col.insert_one(dict(bt_run))
    bt_run.pop("_id", None)
    return bt_run


async def list_backtest_runs(limit: int = 50) -> List[Dict[str, Any]]:
    return await backtest_runs_col.find({}, {"_id": 0}).sort("created_at", -1).to_list(limit)


async def get_backtest_run(backtest_id: str) -> Optional[Dict[str, Any]]:
    run = await backtest_runs_col.find_one({"id": backtest_id}, {"_id": 0})
    if not run:
        return None
    trades = await backtest_trades_col.find(
        {"backtest_run_id": backtest_id}, {"_id": 0},
    ).sort("return_pct", -1).to_list(500)
    run["trades"] = trades
    return run
