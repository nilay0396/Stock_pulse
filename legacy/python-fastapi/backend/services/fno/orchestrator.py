"""Orchestrator: walk providers in order, pick the first that returns
populated data, and enrich with analytics + AI-ready bias signal."""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Tuple

from .providers import fetch_upstox, fetch_fyers, fetch_nse, fetch_yfinance
from .types import OptionChain

logger = logging.getLogger(__name__)

# Order matters. First provider that returns a populated chain wins.
PROVIDER_ORDER = [
    ("upstox", fetch_upstox),
    ("fyers", fetch_fyers),
    ("nse", fetch_nse),
    ("yfinance", fetch_yfinance),
]


async def get_option_chain(symbol: str) -> Dict[str, Any]:
    """Try every provider in order. Return the first populated chain,
    enriched with analytics. If none succeed, return an honest "no data"
    dict carrying every provider's error for debugging.
    """
    attempts: List[Tuple[str, str]] = []
    for name, fetcher in PROVIDER_ORDER:
        try:
            chain: OptionChain = await fetcher(symbol)
        except Exception as e:  # noqa: BLE001
            attempts.append((name, f"exception: {type(e).__name__}: {e}"))
            logger.warning("F&O provider %s raised for %s: %s", name, symbol, e)
            continue
        if chain.is_populated():
            out = chain.to_dict()
            out["analytics"] = enrich_with_analytics(chain)
            out["providers_tried"] = [{"provider": n, "error": err}
                                      for n, err in attempts]
            return out
        attempts.append((name, chain.error or "unknown"))

    # Nothing populated — surface the honest "unavailable" payload
    return {
        "symbol": symbol, "eligible": False, "source": "none",
        "error": "F&O data unavailable from any configured provider",
        "providers_tried": [{"provider": n, "error": err} for n, err in attempts],
        "analytics": None,
    }


# ---------------------------------------------------------------------------
# Analytics — run on a populated chain
# ---------------------------------------------------------------------------
def enrich_with_analytics(chain: OptionChain) -> Dict[str, Any]:
    """Derive: total OI, PCR, ATM strike, max-OI strikes, top lists,
    OI concentration near spot, directional bias, confidence."""
    total_call_oi = sum(c.oi for c in chain.calls)
    total_put_oi = sum(p.oi for p in chain.puts)
    pcr = round(total_put_oi / total_call_oi, 3) if total_call_oi else None

    # ATM strike = strike closest to underlying
    spot = chain.underlying
    atm = None
    if spot and chain.calls:
        atm = min({c.strike for c in chain.calls}, key=lambda s: abs(s - spot))

    # Max-OI strikes — strong resistance (calls) / support (puts) markers
    max_call = max(chain.calls, key=lambda c: c.oi, default=None)
    max_put = max(chain.puts, key=lambda p: p.oi, default=None)

    # Top 5 by OI (already small from providers, but re-sort defensively)
    top_calls = [c.to_dict() for c in sorted(chain.calls, key=lambda c: c.oi, reverse=True)[:5]]
    top_puts = [p.to_dict() for p in sorted(chain.puts, key=lambda p: p.oi, reverse=True)[:5]]

    # OI concentration near spot (within ±5% of underlying)
    oi_near = {"calls": 0, "puts": 0}
    if spot:
        band = spot * 0.05
        oi_near["calls"] = sum(c.oi for c in chain.calls if abs(c.strike - spot) <= band)
        oi_near["puts"] = sum(p.oi for p in chain.puts if abs(p.strike - spot) <= band)

    bias, confidence = _bias_from_chain(
        pcr=pcr,
        max_call=max_call.strike if max_call else None,
        max_put=max_put.strike if max_put else None,
        spot=spot,
        total_call_oi=total_call_oi, total_put_oi=total_put_oi,
        n_contracts=len(chain.calls) + len(chain.puts),
    )

    return {
        "total_call_oi": total_call_oi,
        "total_put_oi": total_put_oi,
        "pcr": pcr,
        "nearest_expiry": chain.expiries[0] if chain.expiries else None,
        "atm_strike": atm,
        "max_oi_call_strike": max_call.strike if max_call else None,
        "max_oi_put_strike": max_put.strike if max_put else None,
        "top_calls": top_calls,
        "top_puts": top_puts,
        "oi_near_spot": oi_near,
        "bias": bias,                 # "bullish" | "bearish" | "neutral" | "unavailable"
        "confidence": confidence,     # 0.0 – 1.0
    }


def _bias_from_chain(
    pcr, max_call, max_put, spot, total_call_oi, total_put_oi, n_contracts,
) -> tuple:
    """Derive a directional F&O bias with a 0-1 confidence score.

    Heuristics (combined):
      • PCR > 1.4  → bullish (puts are being written / calls bought)
      • PCR < 0.7  → bearish
      • Spot > max-OI put strike AND close to max-OI call → bullish
      • Spot < max-OI call strike AND close to max-OI put → bearish
      • Else neutral.

    Confidence scales with (a) data completeness (#contracts), (b) OI magnitude.
    """
    if pcr is None or total_call_oi + total_put_oi == 0:
        return "unavailable", 0.0
    sig_b = 0
    sig_s = 0
    if pcr >= 1.4: sig_b += 2
    elif pcr >= 1.1: sig_b += 1
    if pcr <= 0.7: sig_s += 2
    elif pcr <= 0.9: sig_s += 1

    if spot and max_put and max_call:
        if spot > max_put and abs(spot - max_call) / spot <= 0.03: sig_b += 1
        if spot < max_call and abs(spot - max_put) / spot <= 0.03: sig_s += 1

    if sig_b > sig_s + 1:
        bias = "bullish"
    elif sig_s > sig_b + 1:
        bias = "bearish"
    else:
        bias = "neutral"
    # Confidence: more contracts + more OI = more trustworthy
    conf = min(1.0, (n_contracts / 40) * 0.5 + (min(total_call_oi + total_put_oi, 2_000_000) / 2_000_000) * 0.5)
    return bias, round(conf, 2)
