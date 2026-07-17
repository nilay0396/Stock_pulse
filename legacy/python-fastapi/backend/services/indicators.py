"""Pure-python / pandas technical indicators. No TA-Lib dependency."""
from __future__ import annotations
from typing import Dict, Any, Optional

import numpy as np
import pandas as pd


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Dict[str, pd.Series]:
    fast_e = ema(series, fast)
    slow_e = ema(series, slow)
    line = fast_e - slow_e
    sig = ema(line, signal)
    hist = line - sig
    return {"macd": line, "signal": sig, "hist": hist}


def bollinger(series: pd.Series, period: int = 20, num_std: float = 2.0) -> Dict[str, pd.Series]:
    mid = sma(series, period)
    std = series.rolling(period).std()
    return {"upper": mid + num_std * std, "lower": mid - num_std * std, "mid": mid}


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period).mean()


def _last(series: pd.Series) -> Optional[float]:
    if series is None or series.empty:
        return None
    v = series.iloc[-1]
    if pd.isna(v):
        return None
    return float(v)


def compute_snapshot(df: pd.DataFrame, benchmark_close: Optional[pd.Series] = None) -> Dict[str, Any]:
    """Compute the full technical snapshot for a single stock OHLCV DataFrame."""
    if df is None or df.empty or "Close" not in df.columns:
        return {}

    close = df["Close"].dropna()
    high = df["High"]
    low = df["Low"]
    volume = df.get("Volume", pd.Series(dtype=float))
    if len(close) < 30:
        return {}

    macd_vals = macd(close)
    bb = bollinger(close)
    atr_v = atr(high, low, close)
    rsi_v = rsi(close)

    last_close = float(close.iloc[-1])

    def pct_change(periods: int) -> float:
        if len(close) <= periods:
            return 0.0
        prev = float(close.iloc[-1 - periods])
        if prev == 0:
            return 0.0
        return (last_close - prev) / prev * 100

    sma_20 = _last(sma(close, 20))
    sma_50 = _last(sma(close, 50))
    sma_100 = _last(sma(close, 100))
    sma_200 = _last(sma(close, 200))

    vol_avg_20 = float(volume.tail(20).mean()) if not volume.empty else 0.0
    vol_last = float(volume.iloc[-1]) if not volume.empty else 0.0
    vol_spike = (vol_last / vol_avg_20) if vol_avg_20 > 0 else 1.0

    # Volatility: std of daily returns * sqrt(252) * 100
    returns = close.pct_change().dropna()
    vol_20 = float(returns.tail(20).std() * np.sqrt(252) * 100) if len(returns) > 20 else 0.0

    # Relative strength vs benchmark (1m % - benchmark 1m %)
    rel = 0.0
    if benchmark_close is not None and len(benchmark_close) > 22:
        bm_last = float(benchmark_close.iloc[-1])
        bm_prev = float(benchmark_close.iloc[-22])
        bm_pct = ((bm_last - bm_prev) / bm_prev * 100) if bm_prev else 0.0
        rel = pct_change(22) - bm_pct

    # Setup classification
    setup = "neutral"
    bb_upper = _last(bb["upper"])
    bb_lower = _last(bb["lower"])
    if bb_upper and last_close >= bb_upper * 0.995:
        setup = "breakout"
    elif bb_lower and last_close <= bb_lower * 1.005:
        setup = "pullback" if (sma_50 and last_close >= sma_50) else "downtrend"
    elif sma_20 and sma_50 and sma_20 > sma_50 and last_close > sma_20:
        setup = "pullback" if last_close < (sma_20 * 1.02) else "breakout"
    elif sma_20 and sma_50 and sma_20 < sma_50:
        setup = "downtrend"
    else:
        setup = "range"

    return {
        "last_close": round(last_close, 4),
        "change_pct_1d": round(pct_change(1), 3),
        "change_pct_1w": round(pct_change(5), 3),
        "change_pct_1m": round(pct_change(22), 3),
        "rsi_14": round(_last(rsi_v), 2) if _last(rsi_v) is not None else None,
        "sma_20": round(sma_20, 4) if sma_20 else None,
        "sma_50": round(sma_50, 4) if sma_50 else None,
        "sma_100": round(sma_100, 4) if sma_100 else None,
        "sma_200": round(sma_200, 4) if sma_200 else None,
        "ema_20": round(_last(ema(close, 20)), 4) if _last(ema(close, 20)) else None,
        "ema_50": round(_last(ema(close, 50)), 4) if _last(ema(close, 50)) else None,
        "macd": round(_last(macd_vals["macd"]), 4) if _last(macd_vals["macd"]) is not None else None,
        "macd_signal": round(_last(macd_vals["signal"]), 4) if _last(macd_vals["signal"]) is not None else None,
        "macd_hist": round(_last(macd_vals["hist"]), 4) if _last(macd_vals["hist"]) is not None else None,
        "bb_upper": round(bb_upper, 4) if bb_upper else None,
        "bb_lower": round(bb_lower, 4) if bb_lower else None,
        "bb_mid": round(_last(bb["mid"]), 4) if _last(bb["mid"]) else None,
        "atr_14": round(_last(atr_v), 4) if _last(atr_v) else None,
        "volatility_20": round(vol_20, 3),
        "volume_spike": round(vol_spike, 3),
        "volume_avg_20": round(vol_avg_20, 0),
        "relative_strength": round(rel, 3),
        "setup": setup,
    }
