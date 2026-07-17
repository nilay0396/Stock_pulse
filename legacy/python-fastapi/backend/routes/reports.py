"""Reports: history + detail + preview + manual trigger."""
import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user, require_admin
from db import report_runs_col, ideas_col
from services.report import generate_report
from utils import clean

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/history")
async def history(limit: int = Query(20, ge=1, le=200), user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    docs = await report_runs_col.find({}, {"_id": 0}).sort("started_at", -1).to_list(limit)
    # drop heavy macro payload and sanitize any legacy bson types
    out = []
    for d in docs:
        summary = d.get("summary") or {}
        if isinstance(summary, dict):
            summary.pop("macro", None)
        out.append(clean(d))
    return out


@router.get("/latest")
async def latest(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    doc = await report_runs_col.find_one({"status": "success"}, {"_id": 0}, sort=[("started_at", -1)])
    if not doc:
        return {"status": "empty"}
    return clean(doc)


@router.get("/{run_id}")
async def get_report(run_id: str, user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    doc = await report_runs_col.find_one({"id": run_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Report not found")
    ideas = await ideas_col.find({"report_run_id": run_id}, {"_id": 0}).to_list(200)
    doc["ideas"] = ideas
    return clean(doc)


@router.post("/run")
async def manual_run(user: dict = Depends(require_admin), skip_llm: bool = False) -> Dict[str, Any]:
    """Kick off report generation asynchronously; returns immediately."""
    async def _bg():
        await generate_report(triggered_by=f"manual:{user['id']}", skip_llm=skip_llm)
    asyncio.create_task(_bg())
    return {"ok": True, "status": "started"}


@router.post("/run-sync")
async def manual_run_sync(user: dict = Depends(require_admin), skip_llm: bool = True) -> Dict[str, Any]:
    """Synchronous variant for admin debugging (skip_llm default True to keep fast)."""
    doc = await generate_report(triggered_by=f"manual:{user['id']}", skip_llm=skip_llm)
    return clean(doc)



@router.get("/{run_id}/funnel")
async def funnel_stats(run_id: str, user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """Stage-1 → Stage-3 funnel telemetry for a report run.

    Returns the daily count breakdown (universe → prefilter pool →
    shortlisted → scored → final ideas) plus the top of the lightweight
    rank table so the dashboard can show "what got shortlisted and why".
    """
    doc = await report_runs_col.find_one(
        {"id": run_id},
        {"_id": 0, "id": 1, "run_date": 1, "status": 1,
         "funnel": 1, "summary": 1},
    )
    if not doc:
        raise HTTPException(404, "Report not found")
    summary = doc.get("summary") or {}
    return {
        "run_id": doc["id"],
        "run_date": doc.get("run_date"),
        "status": doc.get("status"),
        "funnel": doc.get("funnel") or summary.get("funnel") or {},
        # Cap returned rank rows to keep payload small for the dashboard
        "lite_rank_top": (summary.get("lite_rank_top") or [])[:100],
    }
