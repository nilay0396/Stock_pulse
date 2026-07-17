"""Normalized F&O data shapes returned by every provider."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class NormalizedContract:
    strike: float
    expiry: str           # ISO date "YYYY-MM-DD"
    oi: int
    change_oi: int = 0
    ltp: Optional[float] = None
    volume: int = 0
    iv: Optional[float] = None
    side: str = "CE"      # "CE" or "PE"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "strike": self.strike, "expiry": self.expiry,
            "oi": self.oi, "change_oi": self.change_oi,
            "ltp": self.ltp, "volume": self.volume,
            "iv": self.iv, "side": self.side,
        }


@dataclass
class OptionChain:
    """Unified F&O data contract. Every provider's output maps to this shape
    so the orchestrator, scoring, and UI are provider-agnostic."""
    symbol: str
    eligible: bool
    source: str              # "upstox" | "fyers" | "nse" | "yfinance" | "none"
    fetched_at: str = ""
    underlying: Optional[float] = None
    expiries: List[str] = field(default_factory=list)
    calls: List[NormalizedContract] = field(default_factory=list)
    puts: List[NormalizedContract] = field(default_factory=list)
    error: Optional[str] = None

    def is_populated(self) -> bool:
        return self.eligible and bool(self.calls or self.puts)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol, "eligible": self.eligible,
            "source": self.source, "fetched_at": self.fetched_at,
            "underlying": self.underlying, "expiries": self.expiries,
            "calls": [c.to_dict() for c in self.calls],
            "puts": [p.to_dict() for p in self.puts],
            "error": self.error,
        }
