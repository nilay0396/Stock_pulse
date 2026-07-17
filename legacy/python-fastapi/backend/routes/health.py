"""Public health + readiness."""
from fastapi import APIRouter

from db import stock_universe_col, report_runs_col

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/readiness")
async def readiness():
    universe_count = await stock_universe_col.count_documents({})
    last = await report_runs_col.find_one({"status": "success"}, {"_id": 0, "run_date": 1, "id": 1}, sort=[("started_at", -1)])
    return {
        "status": "ready",
        "universe_count": universe_count,
        "last_report": last or None,
    }
