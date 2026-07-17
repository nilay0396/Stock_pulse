"""Per-provider F&O fetchers. Each returns `OptionChain` or raises.

A provider MUST:
  • Return a populated `OptionChain` on success (eligible=True, contracts
    present).
  • Return `OptionChain(..., eligible=False, error="…")` on a gentle no-data
    (e.g. "not F&O eligible", "credentials missing") — this tells the
    orchestrator to move on to the next provider without surfacing an error.
  • Raise only on true infra errors (timeouts, malformed upstream data).
"""
from __future__ import annotations
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from db import settings_col
from .types import OptionChain, NormalizedContract

logger = logging.getLogger(__name__)


async def _get_setting(key: str) -> Optional[str]:
    doc = await settings_col.find_one({"key": key}, {"_id": 0, "value": 1})
    if doc and doc.get("value"):
        return str(doc["value"])
    return os.environ.get(key)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# 1) Upstox provider (stub — wire real API once creds + SDK are added)
# ---------------------------------------------------------------------------
async def fetch_upstox(symbol: str) -> OptionChain:
    """Upstox option-chain pull. Requires `UPSTOX_ACCESS_TOKEN` in settings.

    Upstox API endpoint: https://api.upstox.com/v2/option/chain
    Docs: https://upstox.com/developer/api-documentation/
    Returns: NormalisedContract[] across CE + PE for the nearest expiry.

    NOTE: wired as a stub that honours the credential check. The live request
    implementation lands when a real token is added — until then this provider
    reports 'credentials missing' and the orchestrator moves on.
    """
    token = await _get_setting("UPSTOX_ACCESS_TOKEN")
    if not token:
        return OptionChain(symbol=symbol, eligible=False, source="upstox",
                           fetched_at=_now(),
                           error="credentials missing (UPSTOX_ACCESS_TOKEN)")
    # TODO when credentials are added:
    #   async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as c:
    #       r = await c.get("https://api.upstox.com/v2/option/chain",
    #                       params={"instrument_key": f"NSE_EQ|{symbol}",
    #                               "expiry_date": nearest_expiry})
    #       ... normalise into NormalizedContract objects ...
    return OptionChain(symbol=symbol, eligible=False, source="upstox",
                       fetched_at=_now(),
                       error="Upstox integration stubbed — set UPSTOX_ACCESS_TOKEN"
                             " and implement the live client (services/fno/providers.py:fetch_upstox)")


# ---------------------------------------------------------------------------
# 2) Fyers provider (stub)
# ---------------------------------------------------------------------------
async def fetch_fyers(symbol: str) -> OptionChain:
    client_id = await _get_setting("FYERS_CLIENT_ID")
    token = await _get_setting("FYERS_ACCESS_TOKEN")
    if not (client_id and token):
        missing = [k for k, v in (("FYERS_CLIENT_ID", client_id),
                                  ("FYERS_ACCESS_TOKEN", token)) if not v]
        return OptionChain(symbol=symbol, eligible=False, source="fyers",
                           fetched_at=_now(),
                           error=f"credentials missing ({', '.join(missing)})")
    # TODO wire fyers-api-v3 once credentials are present
    return OptionChain(symbol=symbol, eligible=False, source="fyers",
                       fetched_at=_now(),
                       error="Fyers integration stubbed — set FYERS_CLIENT_ID + "
                             "FYERS_ACCESS_TOKEN and implement the live client")


# ---------------------------------------------------------------------------
# 3) NSE direct (DISABLED BY DEFAULT — WAF blocks cloud IPs)
# ---------------------------------------------------------------------------
async def fetch_nse(symbol: str) -> OptionChain:
    """Delegate to the existing NSEOptionChainConnector. Only attempted when
    the admin has explicitly enabled `FNO_ENABLE_NSE_DIRECT` = "true" in
    settings — needed because NSE's Akamai WAF 403's data-center IPs."""
    enabled = (await _get_setting("FNO_ENABLE_NSE_DIRECT") or "").lower() in ("true", "1", "yes")
    if not enabled:
        return OptionChain(symbol=symbol, eligible=False, source="nse",
                           fetched_at=_now(),
                           error="NSE direct disabled (WAF blocks cloud IPs). "
                                 "Set FNO_ENABLE_NSE_DIRECT=true in Admin → Settings to attempt.")
    try:
        from connectors.nse import NSEOptionChainConnector
        res = await NSEOptionChainConnector().run(symbol=symbol)
        d = res.get("data") or {}
        if not d.get("eligible"):
            return OptionChain(symbol=symbol, eligible=False, source="nse",
                               fetched_at=_now(), error=d.get("error"))
        calls = [NormalizedContract(
            strike=float(c["strike"]), expiry=c.get("expiry") or "",
            oi=int(c.get("oi") or 0), change_oi=int(c.get("change_oi") or 0),
            ltp=c.get("ltp"), volume=int(c.get("volume") or 0),
            iv=c.get("iv"), side="CE",
        ) for c in d.get("top_calls") or []]
        puts = [NormalizedContract(
            strike=float(p["strike"]), expiry=p.get("expiry") or "",
            oi=int(p.get("oi") or 0), change_oi=int(p.get("change_oi") or 0),
            ltp=p.get("ltp"), volume=int(p.get("volume") or 0),
            iv=p.get("iv"), side="PE",
        ) for p in d.get("top_puts") or []]
        return OptionChain(
            symbol=symbol, eligible=True, source="nse", fetched_at=_now(),
            underlying=d.get("underlying"),
            expiries=d.get("expiries") or [],
            calls=calls, puts=puts,
        )
    except Exception as e:  # noqa: BLE001
        logger.info("nse option-chain %s failed: %s", symbol, e)
        return OptionChain(symbol=symbol, eligible=False, source="nse",
                           fetched_at=_now(), error=str(e)[:160])


# ---------------------------------------------------------------------------
# 4) yfinance (kept for future — 2026: Indian F&O returns empty)
# ---------------------------------------------------------------------------
async def fetch_yfinance(symbol: str) -> OptionChain:
    """yfinance option_chain for an NSE stock. As of 2026 Yahoo does NOT carry
    Indian F&O chains, so `Ticker.options` returns an empty tuple — we report
    that honestly rather than inventing data.
    """
    import asyncio as _a
    import yfinance as yf
    loop = _a.get_running_loop()
    def _sync():
        t = yf.Ticker(f"{symbol}.NS")
        return list(t.options or [])
    try:
        expiries = await loop.run_in_executor(None, _sync)
    except Exception as e:  # noqa: BLE001
        return OptionChain(symbol=symbol, eligible=False, source="yfinance",
                           fetched_at=_now(), error=str(e)[:160])
    if not expiries:
        return OptionChain(symbol=symbol, eligible=False, source="yfinance",
                           fetched_at=_now(),
                           error="yfinance does not carry Indian F&O chains "
                                 "(0 expiries returned)")
    # Future: when Yahoo ever starts returning expiries for .NS we'd iterate
    # `t.option_chain(exp).calls / .puts` here and normalise.
    return OptionChain(symbol=symbol, eligible=False, source="yfinance",
                       fetched_at=_now(),
                       error="yfinance Indian F&O path not implemented yet "
                             "(expiries were returned though — worth re-checking)")
