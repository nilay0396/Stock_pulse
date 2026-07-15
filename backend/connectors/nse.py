"""NSE India + GDELT connectors. All require browser-like headers; NSE also needs
a cookie handshake (GET the home page first)."""
from __future__ import annotations
import asyncio
import csv
import io
import logging
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

from connectors.base import BaseConnector

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
NSE_HEADERS = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
}


def _sync_client() -> httpx.Client:
    c = httpx.Client(timeout=20, follow_redirects=True, headers=NSE_HEADERS)
    # Seed cookies for api.nseindia.com endpoints
    try:
        c.get("https://www.nseindia.com/")
        c.get("https://www.nseindia.com/all-reports")
    except Exception:
        pass
    return c


async def _run_in_thread(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


# ---------- NSE Bhavcopy (delivery % + volume + value) ----------
def _download_bhav_sync(max_back: int = 7) -> Dict[str, Any]:
    """Download most recent sec_bhavdata_full.csv — has DELIV_PER which is
    the cleanest liquidity/conviction proxy outside of raw volume."""
    c = _sync_client()
    last_err = None
    for i in range(1, max_back + 1):
        d = datetime.now() - timedelta(days=i)
        url = f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv"
        try:
            r = c.get(url)
            if r.status_code == 200 and len(r.content) > 5000:
                rows = list(csv.DictReader(io.StringIO(r.text)))
                # strip whitespace in keys and values
                cleaned = []
                for row in rows:
                    cr = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
                    if cr.get("SERIES") != "EQ":
                        continue
                    cleaned.append({
                        "symbol": cr["SYMBOL"],
                        "date": cr.get("DATE1"),
                        "prev_close": _f(cr.get("PREV_CLOSE")),
                        "open": _f(cr.get("OPEN_PRICE")),
                        "high": _f(cr.get("HIGH_PRICE")),
                        "low": _f(cr.get("LOW_PRICE")),
                        "close": _f(cr.get("CLOSE_PRICE")),
                        "avg_price": _f(cr.get("AVG_PRICE")),
                        "traded_qty": _i(cr.get("TTL_TRD_QNTY")),
                        "turnover_lacs": _f(cr.get("TURNOVER_LACS")),
                        "trades": _i(cr.get("NO_OF_TRADES")),
                        "deliv_qty": _i(cr.get("DELIV_QTY")),
                        "deliv_pct": _f(cr.get("DELIV_PER")),
                    })
                return {"as_of": d.strftime("%Y-%m-%d"), "rows": cleaned, "url": url}
            last_err = f"HTTP {r.status_code} len={len(r.content)}"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
    raise RuntimeError(f"No bhavcopy available in last {max_back} days: {last_err}")


def _f(v):
    try: return float(v) if v not in (None, "", "-") else None
    except: return None


def _i(v):
    try: return int(float(v)) if v not in (None, "", "-") else None
    except: return None


class NSEBhavcopyConnector(BaseConnector):
    name = "nse_bhavcopy"
    category = "market_data"
    max_retries = 2

    async def fetch(self) -> Dict[str, Any]:
        return await _run_in_thread(_download_bhav_sync)


# ---------- NSE Equity master list (full ~2000 EQ-series stocks) ----------
def _download_equity_list_sync() -> List[Dict[str, Any]]:
    """Download EQUITY_L.csv — the canonical NSE master list of all EQ-series
    listed equities. Returns a list of dicts: {symbol, name, isin, listing_date}.
    Used to seed the FULL universe before the institutional funnel kicks in.
    """
    c = _sync_client()
    url = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
    r = c.get(url)
    if r.status_code != 200 or len(r.content) < 5000:
        raise RuntimeError(f"EQUITY_L HTTP {r.status_code} len={len(r.content)}")
    rows = list(csv.DictReader(io.StringIO(r.text)))
    out: List[Dict[str, Any]] = []
    for row in rows:
        cr = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        series = cr.get("SERIES") or cr.get(" SERIES")
        if series != "EQ":
            continue
        sym = cr.get("SYMBOL") or cr.get(" SYMBOL")
        if not sym:
            continue
        out.append({
            "symbol": sym.strip(),
            "name": (cr.get("NAME OF COMPANY") or cr.get(" NAME OF COMPANY") or sym).strip(),
            "isin": (cr.get("ISIN NUMBER") or cr.get(" ISIN NUMBER") or "").strip(),
            "listing_date": (cr.get("DATE OF LISTING") or cr.get(" DATE OF LISTING") or "").strip(),
        })
    return out


class NSEEquityListConnector(BaseConnector):
    """Pulls the full EQ-series master list — the basis for our institutional
    full-universe funnel (Stage 1)."""
    name = "nse_equity_list"
    category = "reference"
    max_retries = 2

    async def fetch(self) -> List[Dict[str, Any]]:
        return await _run_in_thread(_download_equity_list_sync)


# ---------- NSE FII / DII daily flow ----------
def _fetch_fiidii_sync() -> List[Dict[str, Any]]:
    c = _sync_client()
    r = c.get("https://www.nseindia.com/api/fiidiiTradeReact")
    if r.status_code != 200:
        raise RuntimeError(f"fii/dii HTTP {r.status_code}")
    return r.json()


class NSEFIIDIIConnector(BaseConnector):
    name = "nse_fii_dii"
    category = "flows"
    max_retries = 2

    async def fetch(self) -> List[Dict[str, Any]]:
        rows = await _run_in_thread(_fetch_fiidii_sync)
        out = []
        for r in rows or []:
            out.append({
                "category": r.get("category"),
                "date": r.get("date"),
                "buy_value": _f(r.get("buyValue")),
                "sell_value": _f(r.get("sellValue")),
                "net_value": _f(r.get("netValue")),
            })
        return out


# ---------- NSE Insider / PIT disclosures ----------
def _fetch_insider_sync(days_back: int = 30) -> List[Dict[str, Any]]:
    c = _sync_client()
    to_d = datetime.now()
    from_d = to_d - timedelta(days=days_back)
    url = (
        "https://www.nseindia.com/api/corporates-pit"
        f"?index=equities&from_date={from_d.strftime('%d-%m-%Y')}&to_date={to_d.strftime('%d-%m-%Y')}"
    )
    r = c.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"insider HTTP {r.status_code}")
    data = r.json() or {}
    rows = data.get("data") or []
    out = []
    for row in rows:
        out.append({
            "symbol": (row.get("symbol") or "").strip(),
            "company": row.get("company"),
            "acquirer": row.get("acqName"),
            "category": row.get("personCategory"),          # e.g. "Promoters", "Designated Persons"
            "tx_type": row.get("acquisitionMode"),          # e.g. "Market Purchase", "Market Sale"
            "shares": _i(row.get("secAcq")),
            "value": _f(row.get("tdpTransactionValue")),
            "tx_date_from": row.get("afterAcqSharesNo"),    # keep raw: NSE schema drifts
            "disclosure_date": row.get("date"),
            "broadcast_date": row.get("broadcastDate"),
            "tx_date_to": row.get("acqfromDt"),
            "remarks": row.get("remarks"),
            "raw": {k: row.get(k) for k in ("buyValue", "sellValue", "befAcqSharesNo", "afterAcqSharesPer") if k in row},
        })
    return out


class NSEInsiderConnector(BaseConnector):
    name = "nse_insider"
    category = "disclosures"
    max_retries = 2

    async def fetch(self, days_back: int = 30) -> List[Dict[str, Any]]:
        return await _run_in_thread(_fetch_insider_sync, days_back)


# ---------- GDELT global events (free, keyless) ----------
async def _fetch_gdelt(query: str, max_records: int = 15) -> List[Dict[str, Any]]:
    import urllib.parse
    q = urllib.parse.quote(query)
    url = (
        "https://api.gdeltproject.org/api/v2/doc/doc"
        f"?query={q}&mode=artlist&format=json&maxrecords={max_records}"
        "&sort=datedesc"
    )
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"gdelt HTTP {r.status_code}")
    # GDELT returns "Parentheses may only be used..." as plaintext on bad queries
    ct = r.headers.get("content-type", "")
    if "json" not in ct and not r.text.strip().startswith("{"):
        raise RuntimeError(f"gdelt non-json: {r.text[:120]}")
    j = r.json()
    return j.get("articles") or []


class GDELTConnector(BaseConnector):
    name = "gdelt_news"
    category = "geopolitics"
    max_retries = 1   # keyless endpoint — retrying on 429/timeout just makes it worse

    async def fetch(self, query: str = 'India AND (economy OR sanctions OR tariff OR war OR oil OR RBI)', max_records: int = 20) -> List[Dict[str, Any]]:
        try:
            items = await _fetch_gdelt(query, max_records)
        except Exception as e:  # noqa: BLE001
            # GDELT is the most fragile source (rate-limits, CDN flakiness).
            # Log and degrade gracefully; scoring pipeline treats empty geo as neutral.
            import logging
            logging.getLogger(__name__).warning("GDELT skipped: %s", e)
            return []
        out = []
        for it in items:
            out.append({
                "title": it.get("title"),
                "url": it.get("url"),
                "source": it.get("domain"),
                "published_at": it.get("seendate"),
                "language": it.get("language"),
                "country": it.get("sourcecountry"),
                "tone": it.get("tone"),
            })
        return out


# ---------- NSE Sector Indices (all 135 live indices w/ PE) ----------
def _fetch_all_indices_sync() -> List[Dict[str, Any]]:
    c = _sync_client()
    r = c.get("https://www.nseindia.com/api/allIndices")
    if r.status_code != 200:
        raise RuntimeError(f"allIndices HTTP {r.status_code}")
    data = r.json().get("data") or []
    out = []
    for row in data:
        out.append({
            "index": row.get("index"),
            "symbol": row.get("indexSymbol"),
            "last": _f(row.get("last")),
            "prev_close": _f(row.get("previousClose")),
            "open": _f(row.get("open")),
            "high": _f(row.get("high")),
            "low": _f(row.get("low")),
            "change": _f(row.get("variation")),
            "change_pct": _f(row.get("percentChange")),
            "year_high": _f(row.get("yearHigh")),
            "year_low": _f(row.get("yearLow")),
            "pe": _f(row.get("pe")),
            "pb": _f(row.get("pb")),
            "div_yield": _f(row.get("dy")),
        })
    return out


class NSESectorIndicesConnector(BaseConnector):
    name = "nse_sector_indices"
    category = "market_data"
    max_retries = 2

    async def fetch(self) -> List[Dict[str, Any]]:
        return await _run_in_thread(_fetch_all_indices_sync)


# ---------- NSE Corporate Announcements ----------
def _fetch_corp_ann_sync() -> List[Dict[str, Any]]:
    c = _sync_client()
    r = c.get("https://www.nseindia.com/api/corporate-announcements?index=equities")
    if r.status_code != 200:
        raise RuntimeError(f"corp-ann HTTP {r.status_code}")
    rows = r.json() or []
    # Normalise YYYYMMDDHHMMSS timestamps
    def _parse_dt(s):
        try:
            return datetime.strptime(s, "%d%m%Y%H%M%S").isoformat()
        except Exception:
            return s
    return [{
        "symbol": row.get("symbol"),
        "description": row.get("desc"),
        "subject": row.get("subject") or row.get("sm_desc") or row.get("desc"),
        "attachment": row.get("attchmntFile") or row.get("attchmntUrl"),
        "disclosure_time": _parse_dt(row.get("dt") or row.get("an_dt")),
        "time_diff": row.get("exchdisstime"),
    } for row in rows if row.get("symbol")]


class NSECorpAnnouncementsConnector(BaseConnector):
    name = "nse_corp_announcements"
    category = "disclosures"
    max_retries = 2

    async def fetch(self) -> List[Dict[str, Any]]:
        return await _run_in_thread(_fetch_corp_ann_sync)


# ---------- NSE Corporate Actions (dividends/splits/bonuses/buybacks) ----------
def _fetch_corp_actions_sync() -> List[Dict[str, Any]]:
    c = _sync_client()
    r = c.get("https://www.nseindia.com/api/corporates-corporateActions?index=equities")
    if r.status_code != 200:
        raise RuntimeError(f"corp-actions HTTP {r.status_code}")
    rows = r.json() or []
    return [{
        "symbol": row.get("symbol"),
        "series": row.get("series"),
        "subject": row.get("subject"),
        "ex_date": row.get("exDate"),
        "record_date": row.get("recDate"),
        "bc_start": row.get("bcStartDate"),
        "bc_end": row.get("bcEndDate"),
        "face_value": _f(row.get("faceVal")),
        "industry": row.get("ind"),
    } for row in rows if row.get("symbol")]


class NSECorpActionsConnector(BaseConnector):
    name = "nse_corp_actions"
    category = "disclosures"
    max_retries = 2

    async def fetch(self) -> List[Dict[str, Any]]:
        return await _run_in_thread(_fetch_corp_actions_sync)


# ---------- NSE Financial Results (board-meeting calendar incl. earnings) ----------
def _fetch_financial_results_sync() -> List[Dict[str, Any]]:
    """Upcoming board meetings from NSE's event-calendar — the most reliable free
    signal for the next earnings date per symbol. We filter for purposes
    containing "Financial Results" so we can exclude stocks whose earnings fall
    inside a trade's holding horizon."""
    c = _sync_client()
    url = "https://www.nseindia.com/api/event-calendar"
    r = c.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"event-calendar HTTP {r.status_code}")
    rows = r.json() or []
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    import datetime as _dt
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = row.get("symbol")
        purpose = (row.get("purpose") or "").strip()
        raw_date = row.get("date")
        if not (sym and purpose and raw_date):
            continue
        # We only care about earnings events
        if "result" not in purpose.lower():
            continue
        # Convert "22-Apr-2026" -> "2026-04-22"
        try:
            bm_iso = _dt.datetime.strptime(raw_date, "%d-%b-%Y").strftime("%Y-%m-%d")
        except ValueError:
            bm_iso = raw_date
        out.append({
            "symbol": sym.upper(),
            "company": row.get("company"),
            "bm_date": bm_iso,
            "bm_date_raw": raw_date,
            "purpose": purpose,
            "bm_desc": row.get("bm_desc"),
            "period": "Upcoming",
        })
    return out


class NSEFinancialResultsConnector(BaseConnector):
    name = "nse_financial_results"
    category = "disclosures"
    max_retries = 2

    async def fetch(self, period: str = "Upcoming") -> List[Dict[str, Any]]:
        # `period` kept for backward compatibility — NSE's event-calendar is a
        # single rolling-window endpoint, so we ignore the parameter internally.
        return await _run_in_thread(_fetch_financial_results_sync)


# ---------- NSE Quote Equity (live P/E + sector P/E per symbol) ----------
def _fetch_quote_sync(symbol: str) -> Dict[str, Any]:
    c = _sync_client()
    r = c.get(f"https://www.nseindia.com/api/quote-equity?symbol={symbol}")
    if r.status_code != 200:
        raise RuntimeError(f"quote {symbol} HTTP {r.status_code}")
    d = r.json() or {}
    md = d.get("metadata") or {}
    pi = d.get("priceInfo") or {}
    ii = d.get("industryInfo") or {}
    return {
        "symbol": symbol,
        "industry": ii.get("industry") or md.get("industry"),
        "sector": ii.get("sector") or md.get("sector"),
        "pe": _f(md.get("pdSymbolPe")),
        "sector_pe": _f(md.get("pdSectorPe")),
        "last": _f(pi.get("lastPrice")),
        "change_pct": _f(pi.get("pChange")),
        "intraday_high": _f(pi.get("intraDayHighLow", {}).get("max") if isinstance(pi.get("intraDayHighLow"), dict) else None),
        "intraday_low": _f(pi.get("intraDayHighLow", {}).get("min") if isinstance(pi.get("intraDayHighLow"), dict) else None),
        "week52_high": _f(pi.get("weekHighLow", {}).get("max") if isinstance(pi.get("weekHighLow"), dict) else None),
        "week52_low": _f(pi.get("weekHighLow", {}).get("min") if isinstance(pi.get("weekHighLow"), dict) else None),
    }


class NSEQuoteConnector(BaseConnector):
    name = "nse_quote"
    category = "market_data"
    max_retries = 2

    async def fetch(self, symbols: List[str]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sym in symbols:
            try:
                out[sym] = await _run_in_thread(_fetch_quote_sync, sym)
            except Exception as e:  # noqa: BLE001
                logger.warning("quote %s failed: %s", sym, e)
            await asyncio.sleep(0.15)  # gentle rate-limit
        return out


# ---------- NSE Shareholding Pattern ----------
def _fetch_shp_sync(symbol: str) -> List[Dict[str, Any]]:
    c = _sync_client()
    r = c.get(f"https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol={symbol}")
    if r.status_code != 200:
        raise RuntimeError(f"shp {symbol} HTTP {r.status_code}")
    rows = r.json() or []
    out = []
    for row in rows[:8]:  # last 8 filings = 2 years
        out.append({
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "date": row.get("date"),
            "xbrl": row.get("xbrl"),
            "pdf": row.get("submittedFile"),
            "description": row.get("desc"),
        })
    return out


class NSEShareholdingConnector(BaseConnector):
    name = "nse_shareholding"
    category = "disclosures"
    max_retries = 2

    async def fetch(self, symbols: List[str]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for sym in symbols[:15]:  # bounded — shareholding is filed quarterly, no need to refresh all 52 daily
            try:
                out[sym] = await _run_in_thread(_fetch_shp_sync, sym)
            except Exception as e:  # noqa: BLE001
                logger.warning("shp %s failed: %s", sym, e)
            await asyncio.sleep(0.15)
        return out



# ---------- NSE Option Chain (F&O) ----------
def _fetch_option_chain_sync(symbol: str) -> Dict[str, Any]:
    """Pull NSE option chain for an F&O-eligible stock. Returns aggregated
    summary: total call/put OI, PCR, top OI strikes, nearest-expiry futures.
    Raises on HTTP error so the caller can mark the stock as non-F&O.
    """
    c = _sync_client()
    r = c.get(f"https://www.nseindia.com/api/option-chain-equities?symbol={symbol}")
    if r.status_code != 200:
        raise RuntimeError(f"option-chain {symbol} HTTP {r.status_code}")
    payload = r.json() or {}
    records = (payload.get("records") or {})
    rows = records.get("data") or []
    if not rows:
        return {"eligible": False}

    expiries = records.get("expiryDates") or []
    underlying = records.get("underlyingValue")
    total_call_oi = 0
    total_put_oi = 0
    call_rows: List[Dict[str, Any]] = []
    put_rows: List[Dict[str, Any]] = []
    for row in rows:
        ce = row.get("CE") or {}
        pe = row.get("PE") or {}
        if ce:
            total_call_oi += int(ce.get("openInterest") or 0)
            call_rows.append({
                "strike": ce.get("strikePrice"),
                "expiry": ce.get("expiryDate"),
                "oi": int(ce.get("openInterest") or 0),
                "change_oi": int(ce.get("changeinOpenInterest") or 0),
                "ltp": ce.get("lastPrice"),
                "volume": int(ce.get("totalTradedVolume") or 0),
                "iv": ce.get("impliedVolatility"),
            })
        if pe:
            total_put_oi += int(pe.get("openInterest") or 0)
            put_rows.append({
                "strike": pe.get("strikePrice"),
                "expiry": pe.get("expiryDate"),
                "oi": int(pe.get("openInterest") or 0),
                "change_oi": int(pe.get("changeinOpenInterest") or 0),
                "ltp": pe.get("lastPrice"),
                "volume": int(pe.get("totalTradedVolume") or 0),
                "iv": pe.get("impliedVolatility"),
            })

    pcr = round(total_put_oi / total_call_oi, 3) if total_call_oi else None
    top_calls = sorted(call_rows, key=lambda x: x["oi"], reverse=True)[:5]
    top_puts = sorted(put_rows, key=lambda x: x["oi"], reverse=True)[:5]
    return {
        "eligible": True,
        "underlying": underlying,
        "expiries": expiries[:5],
        "nearest_expiry": expiries[0] if expiries else None,
        "total_call_oi": total_call_oi,
        "total_put_oi": total_put_oi,
        "pcr": pcr,
        "top_calls": top_calls,
        "top_puts": top_puts,
    }


class NSEOptionChainConnector(BaseConnector):
    """F&O option-chain summary for a single equity. NSE returns 401 for
    non-F&O symbols; we treat those as `eligible=False` instead of error."""
    name = "nse_option_chain"
    category = "derivatives"
    max_retries = 1

    async def fetch(self, symbol: str) -> Dict[str, Any]:
        try:
            return await _run_in_thread(_fetch_option_chain_sync, symbol)
        except Exception as e:  # noqa: BLE001
            logger.info("option-chain %s unavailable: %s", symbol, str(e)[:80])
            return {"eligible": False, "error": str(e)[:120]}
