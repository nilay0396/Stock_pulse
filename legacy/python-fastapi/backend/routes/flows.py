"""Flows + insider + geopolitics + sector indices + corporate events endpoints."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from db import (
    fii_dii_col, insider_col, gdelt_col, bhavcopy_col,
    sector_indices_col, corp_ann_col, corp_actions_col, shareholding_col_new,
    fred_col, fmp_col, fin_results_col,
)

router = APIRouter(prefix="/flows", tags=["flows"])


@router.get("/fii-dii")
async def fii_dii(limit: int = Query(30, ge=1, le=200), user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    docs = await fii_dii_col.find({}, {"_id": 0}).sort("ingested_at", -1).to_list(limit)
    return docs


@router.get("/insider")
async def insider(symbol: Optional[str] = None, limit: int = Query(50, ge=1, le=200), user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    q = {}
    if symbol:
        q["symbol"] = symbol.upper()
    docs = await insider_col.find(q, {"_id": 0}).sort("disclosure_date", -1).to_list(limit)
    return docs


@router.get("/geopolitics")
async def geopolitics(limit: int = Query(30, ge=1, le=200), user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    docs = await gdelt_col.find({}, {"_id": 0}).sort("ingested_at", -1).to_list(limit)
    return docs


@router.get("/delivery/{symbol}")
async def delivery_for_symbol(symbol: str, limit: int = Query(30, ge=1, le=200), user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    docs = await bhavcopy_col.find({"symbol": symbol.upper()}, {"_id": 0}).sort("as_of", -1).to_list(limit)
    return docs


@router.get("/sector-indices")
async def sector_indices(user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    docs = await sector_indices_col.find({}, {"_id": 0}).to_list(200)
    # latest snapshot only (we wipe+insert each run)
    docs.sort(key=lambda x: (x.get("change_pct") or 0), reverse=True)
    return docs


@router.get("/corporate-announcements")
async def corporate_announcements(
    symbol: Optional[str] = None,
    limit: int = Query(60, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    q = {}
    if symbol:
        q["symbol"] = symbol.upper()
    return await corp_ann_col.find(q, {"_id": 0}).sort("disclosure_time", -1).to_list(limit)


@router.get("/corporate-actions")
async def corporate_actions(
    symbol: Optional[str] = None,
    limit: int = Query(100, ge=1, le=300),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    q = {}
    if symbol:
        q["symbol"] = symbol.upper()
    return await corp_actions_col.find(q, {"_id": 0}).sort("ex_date", 1).to_list(limit)


@router.get("/shareholding/{symbol}")
async def shareholding(symbol: str, user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return await shareholding_col_new.find({"symbol": symbol.upper()}, {"_id": 0}).sort("date", -1).to_list(12)


@router.get("/fred")
async def fred_snapshot(user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return await fred_col.find({}, {"_id": 0}).sort("ingested_at", -1).to_list(50)


@router.get("/fmp/{symbol}")
async def fmp_for_symbol(symbol: str, user: dict = Depends(get_current_user)) -> Optional[Dict[str, Any]]:
    doc = await fmp_col.find_one({"symbol": symbol.upper()}, {"_id": 0}, sort=[("ingested_at", -1)])
    return doc


@router.get("/financial-results")
async def financial_results(
    symbol: Optional[str] = None,
    limit: int = Query(200, ge=1, le=500),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Upcoming earnings / board-meeting calendar. Used by the scoring pipeline
    to exclude stocks whose results fall inside a trade's holding horizon."""
    q = {}
    if symbol:
        q["symbol"] = symbol.upper()
    return await fin_results_col.find(q, {"_id": 0}).sort("bm_date", 1).to_list(limit)
