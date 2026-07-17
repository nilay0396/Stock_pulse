"""Multi-source RSS news connector.

Pulls from Economic Times Markets, Business Standard, Reuters, and Moneycontrol
to give the scoring pipeline a news diet that is NOT solely dependent on
yfinance's Yahoo Finance feed (which is rate-limited and US-skewed).

Downstream consumers get deduplicated headlines with a `scope` classification
(company / sector / macro) and a `matched_symbols` list for efficient per-stock
aggregation.
"""
from __future__ import annotations
import asyncio
import hashlib
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

import httpx

from connectors.base import BaseConnector

logger = logging.getLogger(__name__)

RSS_FEEDS = [
    ("economic_times",
     "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"),
    ("business_standard",
     "https://www.business-standard.com/rss/markets-106.rss"),
    ("moneycontrol_markets",
     "https://www.moneycontrol.com/rss/latestnews.xml"),
    ("moneycontrol_business",
     "https://www.moneycontrol.com/rss/business.xml"),
    ("reuters_business",
     "https://www.reutersagency.com/feed/?best-sectors=business-finance&post_type=best"),
]

# Simple keyword sets for scope classification
SECTOR_KEYWORDS = {
    "Banking": {"bank", "nbfc", "loan", "credit", "deposit", "rbi", "npa"},
    "IT": {"tcs", "infosys", "wipro", "hcl", "tech mahindra", "it services", "software"},
    "Pharma": {"pharma", "drug", "fda", "generic", "healthcare"},
    "Auto": {"auto", "car", "vehicle", "ev", "two-wheeler", "truck"},
    "FMCG": {"fmcg", "consumer goods", "hul", "itc", "nestle"},
    "Metals": {"steel", "copper", "aluminium", "metals", "mining"},
    "Energy": {"oil", "crude", "gas", "petroleum", "ongc", "refinery"},
    "Infrastructure": {"infra", "cement", "construction", "road", "port"},
    "Power": {"power", "electricity", "renewable", "coal"},
    "Chemicals": {"chemical", "paint", "specialty"},
    "Consumer": {"retail", "fashion", "d2c", "titan", "jubilant"},
    "Telecom": {"telecom", "5g", "bharti", "jio", "vodafone"},
}
MACRO_KEYWORDS = {
    "rbi", "rate cut", "rate hike", "inflation", "cpi", "wpi", "gdp", "budget",
    "fii", "dii", "fiscal deficit", "trade deficit", "monsoon", "fed",
    "interest rate", "bond yield", "rupee",
}


def _norm_title(t: str) -> str:
    t = re.sub(r"[^a-z0-9 ]", " ", (t or "").lower())
    return re.sub(r"\s+", " ", t).strip()


def _hash_title(t: str) -> str:
    # NOTE: Used purely as a dedup key across RSS feeds (non-security). We use
    # SHA-256 truncated to 12 hex chars so we don't rely on MD5, which is
    # cryptographically broken — even though this isn't a security context.
    return hashlib.sha256(_norm_title(t).encode("utf-8")).hexdigest()[:12]


def _parse_rss_entries(xml_text: str) -> List[Dict[str, str]]:
    """Tiny dependency-free RSS/Atom parser — extracts title/link/pubDate/description."""
    items = []
    for m in re.finditer(r"<item>(.*?)</item>", xml_text, re.S | re.I):
        block = m.group(1)

        def _tag(t):
            mm = re.search(rf"<{t}[^>]*>(.*?)</{t}>", block, re.S | re.I)
            if not mm:
                return ""
            raw = mm.group(1).strip()
            # strip CDATA wrapping
            raw = re.sub(r"^<!\[CDATA\[(.*?)\]\]>$", r"\1", raw, flags=re.S)
            return re.sub(r"<[^>]+>", "", raw).strip()

        title = _tag("title")
        if not title:
            continue
        items.append({
            "title": title,
            "link": _tag("link"),
            "pub_date": _tag("pubdate") or _tag("dc:date"),
            "description": _tag("description")[:400],
        })
    return items


def _classify(title: str, desc: str, symbols: Dict[str, str]) -> Dict[str, Any]:
    """Return {scope, matched_symbols, matched_sectors}. Lightweight keyword match."""
    hay = (title + " " + desc).lower()
    matched_syms: List[str] = []
    for sym, name in symbols.items():
        # Match exact symbol token OR first 2 words of company name
        name_tokens = re.split(r"\s+", (name or "").lower())[:2]
        name_probe = " ".join(name_tokens).strip()
        if re.search(rf"\b{re.escape(sym.lower())}\b", hay):
            matched_syms.append(sym)
        elif name_probe and name_probe in hay and len(name_probe) > 3:
            matched_syms.append(sym)
    matched_sectors = [s for s, kws in SECTOR_KEYWORDS.items() if any(k in hay for k in kws)]
    is_macro = any(k in hay for k in MACRO_KEYWORDS)

    if matched_syms:
        scope = "company"
    elif is_macro and not matched_sectors:
        scope = "macro"
    elif matched_sectors:
        scope = "sector"
    elif is_macro:
        scope = "macro"
    else:
        scope = "other"
    return {"scope": scope, "matched_symbols": matched_syms, "matched_sectors": matched_sectors}


async def _fetch_feed(client: httpx.AsyncClient, source: str, url: str) -> List[Dict[str, Any]]:
    try:
        r = await client.get(url, timeout=15.0, headers={"User-Agent": "MarketPulse/1.0"})
        if r.status_code != 200:
            logger.warning("RSS %s HTTP %s", source, r.status_code)
            return []
        return [{**e, "source": source} for e in _parse_rss_entries(r.text)]
    except Exception as e:  # noqa: BLE001
        logger.warning("RSS %s failed: %s", source, e)
        return []


class RSSNewsConnector(BaseConnector):
    """Multi-source RSS news ingestion with classification + dedup."""
    name = "rss_news"
    category = "news"
    max_retries = 1

    async def fetch(
        self,
        universe: Optional[List[Dict[str, Any]]] = None,
        max_per_feed: int = 40,
    ) -> List[Dict[str, Any]]:
        """Return a flat list of deduplicated, classified news items."""
        universe = universe or []
        # symbol -> company name (first two words matter for matching)
        symbols = {u.get("symbol", "").upper(): u.get("name", "") for u in universe if u.get("symbol")}

        async with httpx.AsyncClient(follow_redirects=True) as client:
            results = await asyncio.gather(
                *[_fetch_feed(client, s, u) for s, u in RSS_FEEDS],
                return_exceptions=False,
            )

        # Flatten, cap per-feed, dedup by normalized-title hash
        seen: Set[str] = set()
        out: List[Dict[str, Any]] = []
        now = datetime.now(timezone.utc).isoformat()
        for feed in results:
            for item in feed[:max_per_feed]:
                h = _hash_title(item["title"])
                if h in seen:
                    continue
                seen.add(h)
                cls = _classify(item["title"], item.get("description", ""), symbols)
                out.append({
                    **item,
                    "id": h,
                    "ingested_at": now,
                    **cls,
                })
        return out
