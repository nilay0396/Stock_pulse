"""News feed."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from db import news_col

router = APIRouter(prefix="/news", tags=["news"])


@router.get("")
async def list_news(
    symbol: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    q: Dict[str, Any] = {}
    if symbol:
        q["symbol"] = symbol.upper()
    docs = await news_col.find(q, {"_id": 0}).sort("ingested_at", -1).to_list(limit)
    return docs
