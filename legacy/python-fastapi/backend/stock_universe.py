"""Seed universe of Indian NSE-listed stocks with sectors. Large-cap focus for reliable data."""
from typing import List, Dict

UNIVERSE: List[Dict] = [
    # Banks / Financials
    {"symbol": "HDFCBANK", "name": "HDFC Bank", "sector": "Banking", "industry": "Private Bank", "market_cap_tier": "large"},
    {"symbol": "ICICIBANK", "name": "ICICI Bank", "sector": "Banking", "industry": "Private Bank", "market_cap_tier": "large"},
    {"symbol": "SBIN", "name": "State Bank of India", "sector": "Banking", "industry": "Public Bank", "market_cap_tier": "large"},
    {"symbol": "KOTAKBANK", "name": "Kotak Mahindra Bank", "sector": "Banking", "industry": "Private Bank", "market_cap_tier": "large"},
    {"symbol": "AXISBANK", "name": "Axis Bank", "sector": "Banking", "industry": "Private Bank", "market_cap_tier": "large"},
    {"symbol": "BAJFINANCE", "name": "Bajaj Finance", "sector": "Financial Services", "industry": "NBFC", "market_cap_tier": "large"},
    {"symbol": "BAJAJFINSV", "name": "Bajaj Finserv", "sector": "Financial Services", "industry": "Holding", "market_cap_tier": "large"},
    {"symbol": "HDFCLIFE", "name": "HDFC Life Insurance", "sector": "Financial Services", "industry": "Insurance", "market_cap_tier": "large"},
    {"symbol": "SBILIFE", "name": "SBI Life Insurance", "sector": "Financial Services", "industry": "Insurance", "market_cap_tier": "large"},

    # IT
    {"symbol": "TCS", "name": "Tata Consultancy Services", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},
    {"symbol": "INFY", "name": "Infosys", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},
    {"symbol": "WIPRO", "name": "Wipro", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},
    {"symbol": "HCLTECH", "name": "HCL Technologies", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},
    {"symbol": "TECHM", "name": "Tech Mahindra", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},
    {"symbol": "LTIM", "name": "LTIMindtree", "sector": "IT", "industry": "IT Services", "market_cap_tier": "large"},

    # Energy / Oil & Gas
    {"symbol": "RELIANCE", "name": "Reliance Industries", "sector": "Energy", "industry": "Conglomerate", "market_cap_tier": "large"},
    {"symbol": "ONGC", "name": "Oil & Natural Gas Corp", "sector": "Energy", "industry": "Oil & Gas", "market_cap_tier": "large"},
    {"symbol": "IOC", "name": "Indian Oil Corp", "sector": "Energy", "industry": "Oil Marketing", "market_cap_tier": "large"},
    {"symbol": "BPCL", "name": "Bharat Petroleum", "sector": "Energy", "industry": "Oil Marketing", "market_cap_tier": "large"},
    {"symbol": "GAIL", "name": "GAIL India", "sector": "Energy", "industry": "Gas", "market_cap_tier": "large"},

    # Auto
    {"symbol": "MARUTI", "name": "Maruti Suzuki", "sector": "Auto", "industry": "Passenger Vehicles", "market_cap_tier": "large"},
    {"symbol": "M&M", "name": "Mahindra & Mahindra", "sector": "Auto", "industry": "Auto", "market_cap_tier": "large"},
    {"symbol": "BAJAJ-AUTO", "name": "Bajaj Auto", "sector": "Auto", "industry": "Two Wheelers", "market_cap_tier": "large"},
    {"symbol": "HEROMOTOCO", "name": "Hero MotoCorp", "sector": "Auto", "industry": "Two Wheelers", "market_cap_tier": "large"},
    {"symbol": "EICHERMOT", "name": "Eicher Motors", "sector": "Auto", "industry": "Two Wheelers", "market_cap_tier": "large"},

    # FMCG / Consumer
    {"symbol": "HINDUNILVR", "name": "Hindustan Unilever", "sector": "FMCG", "industry": "Personal & HH Care", "market_cap_tier": "large"},
    {"symbol": "ITC", "name": "ITC", "sector": "FMCG", "industry": "Diversified", "market_cap_tier": "large"},
    {"symbol": "NESTLEIND", "name": "Nestle India", "sector": "FMCG", "industry": "Packaged Foods", "market_cap_tier": "large"},
    {"symbol": "BRITANNIA", "name": "Britannia Industries", "sector": "FMCG", "industry": "Packaged Foods", "market_cap_tier": "large"},
    {"symbol": "DABUR", "name": "Dabur India", "sector": "FMCG", "industry": "Personal Care", "market_cap_tier": "large"},
    {"symbol": "TITAN", "name": "Titan Company", "sector": "Consumer", "industry": "Jewellery & Watches", "market_cap_tier": "large"},

    # Pharma
    {"symbol": "SUNPHARMA", "name": "Sun Pharmaceutical", "sector": "Pharma", "industry": "Pharma", "market_cap_tier": "large"},
    {"symbol": "DRREDDY", "name": "Dr. Reddy's Labs", "sector": "Pharma", "industry": "Pharma", "market_cap_tier": "large"},
    {"symbol": "CIPLA", "name": "Cipla", "sector": "Pharma", "industry": "Pharma", "market_cap_tier": "large"},
    {"symbol": "DIVISLAB", "name": "Divi's Laboratories", "sector": "Pharma", "industry": "APIs", "market_cap_tier": "large"},
    {"symbol": "APOLLOHOSP", "name": "Apollo Hospitals", "sector": "Healthcare", "industry": "Hospitals", "market_cap_tier": "large"},

    # Metals & Mining
    {"symbol": "TATASTEEL", "name": "Tata Steel", "sector": "Metals", "industry": "Steel", "market_cap_tier": "large"},
    {"symbol": "JSWSTEEL", "name": "JSW Steel", "sector": "Metals", "industry": "Steel", "market_cap_tier": "large"},
    {"symbol": "HINDALCO", "name": "Hindalco Industries", "sector": "Metals", "industry": "Aluminum & Copper", "market_cap_tier": "large"},
    {"symbol": "COALINDIA", "name": "Coal India", "sector": "Metals", "industry": "Coal", "market_cap_tier": "large"},
    {"symbol": "VEDL", "name": "Vedanta", "sector": "Metals", "industry": "Diversified", "market_cap_tier": "large"},

    # Cement / Construction
    {"symbol": "ULTRACEMCO", "name": "UltraTech Cement", "sector": "Cement", "industry": "Cement", "market_cap_tier": "large"},
    {"symbol": "GRASIM", "name": "Grasim Industries", "sector": "Cement", "industry": "Diversified", "market_cap_tier": "large"},
    {"symbol": "LT", "name": "Larsen & Toubro", "sector": "Infrastructure", "industry": "EPC", "market_cap_tier": "large"},

    # Telecom / Media
    {"symbol": "BHARTIARTL", "name": "Bharti Airtel", "sector": "Telecom", "industry": "Telecom", "market_cap_tier": "large"},

    # Power / Utilities
    {"symbol": "NTPC", "name": "NTPC", "sector": "Power", "industry": "Power Generation", "market_cap_tier": "large"},
    {"symbol": "POWERGRID", "name": "Power Grid Corp", "sector": "Power", "industry": "Transmission", "market_cap_tier": "large"},
    {"symbol": "ADANIPORTS", "name": "Adani Ports & SEZ", "sector": "Infrastructure", "industry": "Ports", "market_cap_tier": "large"},
    {"symbol": "ADANIENT", "name": "Adani Enterprises", "sector": "Infrastructure", "industry": "Diversified", "market_cap_tier": "large"},

    # Paints / Chemicals
    {"symbol": "ASIANPAINT", "name": "Asian Paints", "sector": "Chemicals", "industry": "Paints", "market_cap_tier": "large"},
    {"symbol": "PIDILITIND", "name": "Pidilite Industries", "sector": "Chemicals", "industry": "Adhesives", "market_cap_tier": "large"},
]


def to_yf_symbol(symbol: str) -> str:
    """Map NSE symbol to yfinance symbol."""
    return f"{symbol.replace('&', '%26')}.NS"


async def seed_universe() -> int:
    """Seed the curated 51 large-caps with full sector metadata (idempotent).
    This runs on every boot so the hand-curated sector mapping always wins
    over the bulk seed below.
    """
    from db import stock_universe_col
    inserted = 0
    for item in UNIVERSE:
        symbol = item["symbol"]
        doc = {
            **item,
            "yf_symbol": to_yf_symbol(symbol),
        }
        res = await stock_universe_col.update_one(
            {"symbol": symbol}, {"$set": doc}, upsert=True
        )
        if res.upserted_id:
            inserted += 1
    return inserted


async def seed_full_nse_universe() -> Dict[str, int]:
    """Pull the EQUITY_L master list from NSE and ensure every EQ-series stock
    is in our universe collection. Hand-curated sector tags from `UNIVERSE`
    are preserved; new stocks land with `sector="Other"` and
    `market_cap_tier="unknown"` until the funnel's Stage 1 ranks them.

    Returns counts: {fetched, inserted, total}.
    """
    from connectors.nse import NSEEquityListConnector
    from db import stock_universe_col

    res = await NSEEquityListConnector().run()
    rows = res.get("data") or []
    if not rows:
        raise RuntimeError("EQUITY_L returned no rows")

    curated = {u["symbol"]: u for u in UNIVERSE}
    inserted = 0
    for row in rows:
        sym = row["symbol"]
        # Skip if it's already been seeded with a curated sector (preserve those)
        if sym in curated:
            continue
        doc = {
            "symbol": sym,
            "name": row.get("name") or sym,
            "sector": "Other",
            "industry": "Unknown",
            "market_cap_tier": "unknown",
            "isin": row.get("isin"),
            "listing_date": row.get("listing_date"),
            "yf_symbol": to_yf_symbol(sym),
        }
        # Use insert-if-missing so we never overwrite later sector enrichment
        existing = await stock_universe_col.find_one({"symbol": sym}, {"_id": 1})
        if existing:
            continue
        await stock_universe_col.insert_one(doc)
        inserted += 1

    total = await stock_universe_col.count_documents({})
    return {"fetched": len(rows), "inserted": inserted, "total": total}
