"""Trade ideas + stock scores APIs."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import ideas_col, scores_col, report_runs_col

router = APIRouter(prefix="/ideas", tags=["ideas"])


@router.get("")
async def list_ideas(
    horizon: Optional[str] = Query(None),
    direction: Optional[str] = Query(None),
    sector: Optional[str] = Query(None),
    min_conviction: float = Query(0, ge=0, le=100),
    run_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    q: Dict[str, Any] = {}
    if horizon:
        q["horizon"] = horizon
    if direction:
        q["direction"] = direction
    if sector:
        q["sector"] = sector
    if min_conviction:
        q["conviction"] = {"$gte": min_conviction}
    if run_id:
        q["report_run_id"] = run_id
    else:
        latest = await report_runs_col.find_one({"status": "success"}, {"_id": 0, "id": 1}, sort=[("started_at", -1)])
        if latest:
            q["report_run_id"] = latest["id"]
    docs = await ideas_col.find(q, {"_id": 0}).sort("conviction", -1).to_list(limit)
    return docs


@router.get("/scores")
async def list_scores(
    sector: Optional[str] = None,
    min_conviction: float = Query(0, ge=0, le=100),
    direction: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    latest = await report_runs_col.find_one({"status": "success"}, {"_id": 0, "id": 1}, sort=[("started_at", -1)])
    if not latest:
        return []
    q: Dict[str, Any] = {"report_run_id": latest["id"]}
    if sector:
        q["sector"] = sector
    if direction:
        q["direction"] = direction
    if min_conviction:
        q["conviction"] = {"$gte": min_conviction}
    docs = await scores_col.find(q, {"_id": 0}).sort("conviction", -1).to_list(limit)
    return docs


@router.get("/scores/{symbol}")
async def score_detail(symbol: str, user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    doc = await scores_col.find_one({"symbol": symbol.upper()}, {"_id": 0}, sort=[("as_of", -1)])
    if not doc:
        raise HTTPException(404, "No score found for symbol")
    return doc


@router.get("/excluded")
async def list_excluded(
    run_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Return candidates that qualified on scoring but were filtered out by
    the NSE earnings-calendar rule (earnings falling inside the holding horizon).
    Gives users full transparency on high-conviction stocks that were blocked."""
    q: Dict[str, Any] = {}
    if run_id:
        q["id"] = run_id
    else:
        q["status"] = "success"
    run = await report_runs_col.find_one(q, {"_id": 0, "summary": 1},
                                         sort=[("started_at", -1)])
    if not run:
        return []
    return ((run.get("summary") or {}).get("excluded_by_earnings") or [])
