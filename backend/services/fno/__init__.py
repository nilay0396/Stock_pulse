"""F&O provider chain — pluggable Indian option-chain sources.

Provider order (first one to succeed wins):
    1. Upstox        (broker API; requires UPSTOX_ACCESS_TOKEN)
    2. Fyers         (broker API; requires FYERS_CLIENT_ID + FYERS_ACCESS_TOKEN)
    3. NSE direct    (DISABLED BY DEFAULT — WAF-blocks cloud IPs; enable via settings)
    4. yfinance      (empty for Indian F&O in 2026 — kept for future)

Every provider implements `fetch(symbol) -> OptionChain | None`. The chain
orchestrator (`get_option_chain`) walks providers in order, catches errors,
and normalises each provider's output into a single shape. The UI never has
to know which provider won — it renders whatever the orchestrator returns
plus the `source` field.
"""
from .types import OptionChain, NormalizedContract
from .orchestrator import get_option_chain, enrich_with_analytics

__all__ = ["OptionChain", "NormalizedContract",
           "get_option_chain", "enrich_with_analytics"]
