"""Financial Modeling Prep (secondary fundamentals). Requires free API key (250/day).

Key is optional — stored in system_settings under `fmp_api_key`. When absent, the
connector is a no-op and the report just falls back to yfinance.info.
"""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional

import httpx

from connectors.base import BaseConnector
from services.settings import get as _get_setting

logger = logging.getLogger(__name__)

BASE = "https://financialmodelingprep.com/api/v3"


async def _get_json(path: str, api_key: str, params: Optional[Dict[str, Any]] = None) -> Any:
    params = {**(params or {}), "apikey": api_key}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{BASE}/{path.lstrip('/')}", params=params)
    if r.status_code != 200:
        raise RuntimeError(f"FMP {path} HTTP {r.status_code}: {r.text[:120]}")
    return r.json()


class FMPConnector(BaseConnector):
    """Enriches fundamentals for NSE symbols.

    FMP uses the `.NS` suffix for NSE tickers (same as yfinance).
    """
    name = "fmp_fundamentals"
    category = "fundamentals"
    max_retries = 2

    async def fetch(self, symbols: List[str]) -> Dict[str, Any]:
        api_key = await _get_setting("fmp_api_key", "")
        if not api_key:
            return {"skipped": "no_api_key", "data": {}}

        out: Dict[str, Any] = {}
        # FMP accepts comma-separated tickers on some endpoints but profile/ratios are per-symbol.
        for sym in symbols[:30]:  # cap to preserve free quota
            ticker = f"{sym}.NS"
            try:
                # Ratios TTM — single most useful endpoint: ROE, D/E, interest coverage, margins, etc.
                ratios = await _get_json(f"ratios-ttm/{ticker}", api_key)
                # Key metrics TTM — EV/EBITDA, FCF yield, ROIC
                metrics = await _get_json(f"key-metrics-ttm/{ticker}", api_key)
                # Analyst estimates (next quarter)
                est = await _get_json(f"analyst-estimates/{ticker}", api_key, {"limit": 4})
                out[sym] = {
                    "ratios_ttm": (ratios or [{}])[0] if isinstance(ratios, list) else (ratios or {}),
                    "metrics_ttm": (metrics or [{}])[0] if isinstance(metrics, list) else (metrics or {}),
                    "estimates": est or [],
                }
            except Exception as e:  # noqa: BLE001
                logger.warning("FMP %s failed: %s", sym, e)
        return {"skipped": None, "data": out}
