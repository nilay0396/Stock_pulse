"""yfinance-backed connectors for Indian equities and global macro.

All IO is executed in a thread pool because yfinance is sync.
"""
from __future__ import annotations
import asyncio
import logging
from typing import Any, Dict, List, Optional

import pandas as pd
import yfinance as yf

from connectors.base import BaseConnector

logger = logging.getLogger(__name__)


def _download_sync(tickers: List[str], period: str = "1y", interval: str = "1d") -> pd.DataFrame:
    """Single-threaded yfinance fetch used inside an executor."""
    df = yf.download(
        tickers=" ".join(tickers),
        period=period,
        interval=interval,
        group_by="ticker",
        auto_adjust=True,
        progress=False,
        threads=False,
    )
    return df


async def download_history(
    tickers: List[str], period: str = "1y", interval: str = "1d"
) -> Dict[str, pd.DataFrame]:
    """Returns per-ticker DataFrame with columns: Open High Low Close Volume (adjusted)."""
    loop = asyncio.get_running_loop()
    df = await loop.run_in_executor(None, _download_sync, tickers, period, interval)

    out: Dict[str, pd.DataFrame] = {}
    if df is None or df.empty:
        return out

    if len(tickers) == 1:
        sub = df.dropna(how="all")
        # When yfinance is called with group_by="ticker" + a single ticker we
        # still get a 2-level MultiIndex on the columns. Flatten it so the rest
        # of the pipeline (compute_snapshot etc.) can read "Open"/"High"/etc.
        if isinstance(sub.columns, pd.MultiIndex):
            t = tickers[0]
            if t in sub.columns.get_level_values(0):
                sub = sub[t]
            else:
                # ticker layer is the second level — just keep the OHLCV layer
                sub.columns = sub.columns.get_level_values(-1)
        out[tickers[0]] = sub
        return out

    # Multi-index columns when multiple tickers
    for t in tickers:
        if t in df.columns.get_level_values(0):
            sub = df[t].dropna(how="all")
            if not sub.empty:
                out[t] = sub
    return out


class EquityHistoryConnector(BaseConnector):
    name = "yfinance_equities"
    category = "market_data"

    async def fetch(
        self, tickers: List[str], period: str = "1y", interval: str = "1d",
        chunk_size: int = 50, max_concurrent: int = 4,
    ) -> Dict[str, pd.DataFrame]:
        """Batched 1-yr daily OHLC pull. The full-NSE Stage-1 funnel routinely
        asks for ~1,200 tickers, so we chunk at 50 and run up to 4 chunks in
        parallel via an asyncio Semaphore. yfinance internally calls a single
        Yahoo endpoint per chunk so 4-way concurrency is safe (each chunk is
        one HTTP call). A small jittered sleep keeps us polite to the host.
        """
        if not tickers:
            return {}
        chunks = [tickers[i : i + chunk_size] for i in range(0, len(tickers), chunk_size)]
        sem = asyncio.Semaphore(max_concurrent)
        combined: Dict[str, pd.DataFrame] = {}

        async def _one(chunk: List[str]) -> None:
            async with sem:
                try:
                    res = await download_history(chunk, period=period, interval=interval)
                    combined.update(res)
                except Exception as e:  # noqa: BLE001
                    logger.warning("Chunk download failed (%d tickers): %s", len(chunk), e)
                # tiny gap so we don't hammer Yahoo even at 4-wide
                await asyncio.sleep(0.15)

        await asyncio.gather(*[_one(c) for c in chunks])
        return combined


class MacroConnector(BaseConnector):
    """Fetch macro/index tickers via yfinance."""
    name = "yfinance_macro"
    category = "macro"

    TICKER_MAP = {
        "NIFTY": "^NSEI",
        "BANKNIFTY": "^NSEBANK",
        "SENSEX": "^BSESN",
        "INDIAVIX": "^INDIAVIX",
        "SP500": "^GSPC",
        "NASDAQ": "^IXIC",
        "DOW": "^DJI",
        "FTSE": "^FTSE",
        "NIKKEI": "^N225",
        "HANGSENG": "^HSI",
        "DXY": "DX-Y.NYB",
        "USDINR": "INR=X",
        "CRUDE": "CL=F",
        "BRENT": "BZ=F",
        "NATGAS": "NG=F",
        "GOLD": "GC=F",
        "SILVER": "SI=F",
        "COPPER": "HG=F",
        "US10Y": "^TNX",
        "US2Y": "^FVX",
        "BTC": "BTC-USD",
    }

    async def fetch(self, keys: Optional[List[str]] = None) -> Dict[str, Dict[str, Any]]:
        keys = keys or list(self.TICKER_MAP.keys())
        tickers = [self.TICKER_MAP[k] for k in keys if k in self.TICKER_MAP]
        hist = await download_history(tickers, period="3mo", interval="1d")

        out: Dict[str, Dict[str, Any]] = {}
        for key in keys:
            yf_t = self.TICKER_MAP.get(key)
            if not yf_t or yf_t not in hist:
                continue
            df = hist[yf_t].dropna(subset=["Close"])
            if df.empty:
                continue
            last = float(df["Close"].iloc[-1])
            prev = float(df["Close"].iloc[-2]) if len(df) > 1 else last
            change = last - prev
            change_pct = ((last - prev) / prev * 100) if prev else 0.0
            out[key] = {
                "key": key,
                "yf_symbol": yf_t,
                "last": round(last, 4),
                "prev": round(prev, 4),
                "change": round(change, 4),
                "change_pct": round(change_pct, 3),
                "history": [
                    {"date": str(idx.date()), "close": round(float(v), 4)}
                    for idx, v in df["Close"].tail(60).items()
                ],
            }
        return out


class NewsConnector(BaseConnector):
    """Per-ticker headlines via yfinance (uses Yahoo Finance news feed)."""
    name = "yfinance_news"
    category = "news"

    async def fetch(self, ticker: str, limit: int = 10) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()

        def _sync() -> list:
            t = yf.Ticker(ticker)
            try:
                return t.news or []
            except Exception:
                return []

        items = await loop.run_in_executor(None, _sync)
        out: List[Dict[str, Any]] = []
        for it in items[:limit]:
            content = it.get("content") or it
            title = content.get("title") or it.get("title") or ""
            publisher = content.get("provider", {}).get("displayName") if isinstance(content.get("provider"), dict) else content.get("publisher") or ""
            link = (content.get("canonicalUrl") or {}).get("url") if isinstance(content.get("canonicalUrl"), dict) else it.get("link") or ""
            pub_time = content.get("pubDate") or it.get("providerPublishTime")
            summary = content.get("summary") or ""
            out.append({
                "title": title,
                "publisher": publisher,
                "link": link,
                "published_at": pub_time,
                "summary": summary,
            })
        return out
