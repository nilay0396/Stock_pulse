"""FRED (St. Louis Fed) — US + global macro series. Free API key required.

Key stored in system_settings under `fred_api_key`. When absent, the connector skips.
"""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional

import httpx

from connectors.base import BaseConnector
from services.settings import get as _get_setting

logger = logging.getLogger(__name__)

BASE = "https://api.stlouisfed.org/fred"

# Curated series that matter for India equity strategy
DEFAULT_SERIES = {
    "US_CPI_YOY": "CPIAUCSL",         # US CPI (we compute YoY)
    "US_CORE_CPI_YOY": "CPILFESL",
    "US_UNEMPLOYMENT": "UNRATE",
    "US_FEDFUNDS": "FEDFUNDS",
    "US_10Y": "DGS10",
    "US_2Y": "DGS2",
    "US_ISM_PMI": "MANEMP",           # proxy — true ISM is not on FRED
    "US_RECESSION_PROB": "RECPROUSM156N",
    "INDIA_CPI": "INDCPALTT01IXNBM",  # India CPI all items
    "INDIA_GDP_GROWTH": "RGDPNAINA666NRUG",
    "INDIA_M3": "MABMM301INM189S",
    "WORLD_OIL_PRICE": "POILWTIUSDM",
    "USD_INR_MONTHLY": "EXINUS",
    "EM_VIX": "VXEEMCLS",
}


async def _series_latest(series_id: str, api_key: str, limit: int = 2) -> List[Dict[str, Any]]:
    params = {
        "series_id": series_id,
        "api_key": api_key,
        "file_type": "json",
        "sort_order": "desc",
        "limit": limit,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{BASE}/series/observations", params=params)
    if r.status_code != 200:
        raise RuntimeError(f"FRED {series_id} HTTP {r.status_code}")
    return (r.json() or {}).get("observations") or []


class FREDConnector(BaseConnector):
    name = "fred_macro"
    category = "macro"
    max_retries = 2

    async def fetch(self, series: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        api_key = await _get_setting("fred_api_key", "")
        if not api_key:
            return {"skipped": "no_api_key", "data": {}}
        series = series or DEFAULT_SERIES
        out: Dict[str, Any] = {}
        for key, sid in series.items():
            try:
                obs = await _series_latest(sid, api_key)
                if not obs:
                    continue
                latest = obs[0]
                prev = obs[1] if len(obs) > 1 else None
                last_val = _f(latest.get("value"))
                prev_val = _f(prev.get("value")) if prev else None
                out[key] = {
                    "series_id": sid,
                    "date": latest.get("date"),
                    "value": last_val,
                    "prev": prev_val,
                    "change": (last_val - prev_val) if (last_val is not None and prev_val is not None) else None,
                }
            except Exception as e:  # noqa: BLE001
                logger.warning("FRED %s failed: %s", sid, e)
        return {"skipped": None, "data": out}


def _f(v):
    try: return float(v) if v not in (None, "", ".") else None
    except: return None
