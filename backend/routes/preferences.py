"""User preferences (per-user)."""
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends

from auth import get_current_user
from db import preferences_col

router = APIRouter(prefix="/preferences", tags=["preferences"])


DEFAULT_PREFS = {
    "telegram_chat_id": "",
    "email_alerts": True,
    "telegram_alerts": True,
    "delivery_time": "07:00",
    "language": "en",
    "preferred_sectors": [],
    "horizon": "both",
    "risk_appetite": "medium",
    "watchlist": [],
}


@router.get("")
async def get_prefs(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    doc = await preferences_col.find_one({"user_id": user["id"]}, {"_id": 0})
    if not doc:
        doc = {**DEFAULT_PREFS, "user_id": user["id"]}
    return doc


@router.put("")
async def update_prefs(body: Dict[str, Any], user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    allowed = set(DEFAULT_PREFS.keys())
    patch = {k: v for k, v in body.items() if k in allowed}
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    await preferences_col.update_one(
        {"user_id": user["id"]},
        {"$set": {"user_id": user["id"], **patch}},
        upsert=True,
    )
    doc = await preferences_col.find_one({"user_id": user["id"]}, {"_id": 0})
    return doc
