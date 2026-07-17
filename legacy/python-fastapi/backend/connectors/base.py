"""Base connector interface with retry, rate-limit handling and health tracking."""
from __future__ import annotations
import asyncio
import logging
import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from db import connectors_col, ingestion_runs_col

logger = logging.getLogger(__name__)


class BaseConnector(ABC):
    name: str = "base"
    category: str = "generic"
    max_retries: int = 3
    retry_backoff_s: float = 2.0

    def __init__(self) -> None:
        assert self.name != "base", "Connector must override `name`"

    @abstractmethod
    async def fetch(self, **kwargs: Any) -> Any:
        """Actually talk to the external source. Implementations run in executor if sync."""

    async def run(self, **kwargs: Any) -> Dict[str, Any]:
        """Wrap fetch with retries, logging, ingestion-run record and health tracking."""
        import uuid
        run_id = str(uuid.uuid4())
        started = datetime.now(timezone.utc)
        await ingestion_runs_col.insert_one({
            "id": run_id,
            "connector": self.name,
            "started_at": started.isoformat(),
            "status": "running",
            "rows": 0,
        })

        attempt = 0
        last_err: Optional[str] = None
        t0 = time.time()
        while attempt < self.max_retries:
            attempt += 1
            try:
                data = await self.fetch(**kwargs)
                rows = self._count_rows(data)
                duration_ms = int((time.time() - t0) * 1000)
                await ingestion_runs_col.update_one(
                    {"id": run_id},
                    {"$set": {
                        "status": "success",
                        "rows": rows,
                        "finished_at": datetime.now(timezone.utc).isoformat(),
                    }},
                )
                await self._update_health(success=True, duration_ms=duration_ms, error=None)
                return {"ok": True, "data": data, "rows": rows, "run_id": run_id}
            except Exception as e:  # noqa: BLE001
                last_err = f"{type(e).__name__}: {e}"
                logger.warning("Connector %s attempt %s failed: %s", self.name, attempt, last_err)
                if attempt < self.max_retries:
                    await asyncio.sleep(self.retry_backoff_s * attempt)

        duration_ms = int((time.time() - t0) * 1000)
        await ingestion_runs_col.update_one(
            {"id": run_id},
            {"$set": {
                "status": "failed",
                "error": last_err,
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        await self._update_health(success=False, duration_ms=duration_ms, error=last_err)
        return {"ok": False, "error": last_err, "run_id": run_id}

    async def _update_health(self, success: bool, duration_ms: int, error: Optional[str]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        update = {
            "$set": {
                "name": self.name,
                "category": self.category,
                "last_run_at": now,
                "last_status": "success" if success else "failed",
                "last_error": None if success else error,
            },
            "$inc": {
                "success_count": 1 if success else 0,
                "failure_count": 0 if success else 1,
            },
            "$setOnInsert": {"enabled": True, "avg_duration_ms": float(duration_ms)},
        }
        await connectors_col.update_one({"name": self.name}, update, upsert=True)
        # rolling average
        doc = await connectors_col.find_one({"name": self.name}, {"_id": 0})
        if doc:
            total = (doc.get("success_count") or 0) + (doc.get("failure_count") or 0)
            if total > 0:
                prev = doc.get("avg_duration_ms", duration_ms)
                new_avg = ((prev * (total - 1)) + duration_ms) / total
                await connectors_col.update_one(
                    {"name": self.name}, {"$set": {"avg_duration_ms": new_avg}}
                )

    @staticmethod
    def _count_rows(data: Any) -> int:
        if data is None:
            return 0
        if isinstance(data, (list, tuple)):
            return len(data)
        if isinstance(data, dict):
            return len(data)
        try:
            return len(data)
        except Exception:
            return 1
