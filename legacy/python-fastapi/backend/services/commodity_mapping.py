"""Commodity → Indian sector impact mapping.

Each commodity move produces a dict of sector → signed impact [-1, +1].
Positive impact on a sector boosts its macro_sector score; negative drags it.
"""
from __future__ import annotations
from typing import Dict, Any, Tuple, List


# (commodity_key → {sector_name: weight}) — weight in [-1, +1]
# Rationale briefly in comments; tuned for India 2024-26 cycle.
COMMODITY_SECTOR_IMPACT: Dict[str, Dict[str, float]] = {
    "CRUDE": {
        # Crude up hurts paints (input), airlines, FMCG (packaging), auto (fuel cost).
        # Helps upstream oil producers.
        "Energy": +0.5,            # ONGC, Oil India gain
        "Chemicals": -0.7,          # Paints/specialty chemicals input cost rises (Asian Paints, Pidilite)
        "Auto": -0.3,
        "FMCG": -0.2,
        "Cement": -0.3,             # Freight + pet coke proxy
        "Infrastructure": -0.2,
    },
    "BRENT": {
        "Energy": +0.5,
        "Chemicals": -0.7,
        "Auto": -0.3,
        "FMCG": -0.2,
        "Cement": -0.3,
        "Infrastructure": -0.2,
    },
    "GOLD": {
        # Gold up = jewellery margin squeeze, risk-off positive for PSU banks (sovereign gold bonds)
        "Consumer": -0.5,           # Titan
        "Banking": +0.1,
        "Financial Services": +0.1,
    },
    "SILVER": {
        "Consumer": -0.3,
        "Chemicals": +0.2,          # Industrial silver demand
    },
    "COPPER": {
        # Copper up = strong industrial cycle, positive for infra, metals, capex
        "Metals": +0.6,             # Hindalco, Vedanta
        "Infrastructure": +0.3,
        "Power": +0.2,
        "Auto": +0.1,               # EV wiring
    },
    "NATGAS": {
        "Energy": +0.3,             # GAIL
        "Chemicals": -0.4,          # Urea / fertiliser / specialty chem feedstock
        "Power": -0.2,
    },
    "DXY": {
        # Dollar strength = IT services benefit, metals hurt, importers hurt
        "IT": +0.4,
        "Pharma": +0.3,             # Export-heavy
        "Metals": -0.3,
        "Auto": -0.2,               # Commodity import cost
        "FMCG": -0.1,
    },
    "US10Y": {
        # US yields up = EM outflow risk, rate-sensitive hurt
        "Banking": +0.1,
        "Financial Services": -0.2,
        "Auto": -0.2,                # Loan-driven demand
        "Infrastructure": -0.2,
    },
}


def commodity_deltas(macro: Dict[str, Any]) -> Dict[str, float]:
    """Pull change_pct for each commodity key we care about, default 0."""
    out = {}
    for k in COMMODITY_SECTOR_IMPACT:
        row = macro.get(k) or {}
        out[k] = row.get("change_pct") or 0.0
    return out


def sector_impact_scores(macro: Dict[str, Any]) -> Dict[str, float]:
    """Aggregate commodity deltas → per-sector impact (sum of weight × delta%).

    Result is clipped to [-15, +15] so it can be added to a 0-100 macro score
    without dominating it. Positive = tailwind, negative = headwind.
    """
    deltas = commodity_deltas(macro)
    raw: Dict[str, float] = {}
    for comm, impact_map in COMMODITY_SECTOR_IMPACT.items():
        delta = deltas.get(comm, 0.0)
        for sector, weight in impact_map.items():
            raw[sector] = raw.get(sector, 0.0) + (weight * delta)
    # normalise: each 1% move on a commodity with weight 1 → 1 point of sector impact
    return {s: max(-15.0, min(15.0, v)) for s, v in raw.items()}


def explain(sector: str, impact: float, macro: Dict[str, Any]) -> List[str]:
    """Return human-readable reasons for a sector's impact score."""
    if not sector or sector not in {s for m in COMMODITY_SECTOR_IMPACT.values() for s in m}:
        return []
    notes: List[str] = []
    for comm, impact_map in COMMODITY_SECTOR_IMPACT.items():
        if sector not in impact_map:
            continue
        delta = (macro.get(comm) or {}).get("change_pct") or 0.0
        weight = impact_map[sector]
        effect = weight * delta
        if abs(effect) < 0.3:
            continue
        direction = "tailwind" if effect > 0 else "headwind"
        notes.append(f"{comm} {delta:+.1f}% is a {direction} for {sector}")
    return notes[:3]
