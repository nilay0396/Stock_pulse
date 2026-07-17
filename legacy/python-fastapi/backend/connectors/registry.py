"""Central connector registry with health snapshot."""
from __future__ import annotations
from typing import Dict, List

from connectors.market_data import EquityHistoryConnector, MacroConnector, NewsConnector
from connectors.nse import (
    NSEBhavcopyConnector, NSEFIIDIIConnector, NSEInsiderConnector, GDELTConnector,
    NSESectorIndicesConnector, NSECorpAnnouncementsConnector, NSECorpActionsConnector,
    NSEQuoteConnector, NSEShareholdingConnector, NSEFinancialResultsConnector,
)
from connectors.fmp import FMPConnector
from connectors.fred import FREDConnector
from db import connectors_col


_registry: Dict[str, object] = {
    "yfinance_equities": EquityHistoryConnector(),
    "yfinance_macro": MacroConnector(),
    "yfinance_news": NewsConnector(),
    "nse_bhavcopy": NSEBhavcopyConnector(),
    "nse_fii_dii": NSEFIIDIIConnector(),
    "nse_insider": NSEInsiderConnector(),
    "nse_sector_indices": NSESectorIndicesConnector(),
    "nse_corp_announcements": NSECorpAnnouncementsConnector(),
    "nse_corp_actions": NSECorpActionsConnector(),
    "nse_financial_results": NSEFinancialResultsConnector(),
    "nse_quote": NSEQuoteConnector(),
    "nse_shareholding": NSEShareholdingConnector(),
    "gdelt_news": GDELTConnector(),
    "fmp_fundamentals": FMPConnector(),
    "fred_macro": FREDConnector(),
}


def get(name: str):
    return _registry.get(name)


def all_connectors() -> List[str]:
    return list(_registry.keys())


async def health_snapshot() -> List[dict]:
    docs = await connectors_col.find({}, {"_id": 0}).to_list(100)
    names = {d["name"] for d in docs}
    for name, conn in _registry.items():
        if name not in names:
            docs.append({
                "name": name,
                "category": conn.category,
                "enabled": True,
                "last_status": "idle",
                "success_count": 0,
                "failure_count": 0,
                "avg_duration_ms": 0.0,
            })
    return docs
