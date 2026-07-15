"""APScheduler-driven 7:00 AM IST daily report job."""
from __future__ import annotations
import asyncio
import logging
import os
from datetime import datetime

import pytz
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from services.report import generate_report
from services.settings import get_all as get_settings

logger = logging.getLogger(__name__)

IST = pytz.timezone("Asia/Kolkata")
_scheduler: AsyncIOScheduler | None = None
JOB_ID = "daily-morning-report"


async def _job() -> None:
    logger.info("Running scheduled daily report at %s IST", datetime.now(IST).isoformat())
    try:
        await generate_report(triggered_by="scheduler")
    except Exception as e:  # noqa: BLE001
        logger.exception("Scheduled report failed: %s", e)


async def _catchup_if_missed() -> None:
    """Fire the morning report immediately if today's scheduled slot has
    already passed AND no successful report for today (IST) exists yet.

    This covers the preview-pod sleep scenario: if the pod wasn't running
    at 07:00 IST, APScheduler's next_fire_time silently skips to tomorrow
    and misfire_grace_time doesn't help (no prior fire was tracked). On
    production (24/7 process) this is a no-op because the run already
    exists by the time the process restarts.
    """
    from db import report_runs_col
    settings = await get_settings()
    hour = int(settings.get("report_hour", os.environ.get("REPORT_CRON_HOUR", 7)))
    minute = int(settings.get("report_minute", os.environ.get("REPORT_CRON_MINUTE", 0)))
    now_ist = datetime.now(IST)
    scheduled_today = now_ist.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now_ist < scheduled_today:
        return  # slot hasn't arrived yet — normal scheduler will fire it
    run_date = now_ist.strftime("%Y-%m-%d")
    existing = await report_runs_col.find_one(
        {"run_date": run_date, "status": "success"}, {"_id": 0, "id": 1},
    )
    if existing:
        return
    logger.warning(
        "Scheduler catchup: today's %02d:%02d IST slot passed and no "
        "successful report exists for %s — firing scheduler-catchup now.",
        hour, minute, run_date,
    )
    try:
        await generate_report(triggered_by="scheduler-catchup")
    except Exception as e:  # noqa: BLE001
        logger.exception("Scheduler catchup failed: %s", e)


async def start_scheduler() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        return
    settings = await get_settings()
    hour = int(settings.get("report_hour", os.environ.get("REPORT_CRON_HOUR", 7)))
    minute = int(settings.get("report_minute", os.environ.get("REPORT_CRON_MINUTE", 0)))
    _scheduler = AsyncIOScheduler(timezone=IST)
    _scheduler.add_job(
        _job,
        trigger=CronTrigger(hour=hour, minute=minute, timezone=IST),
        id=JOB_ID, replace_existing=True, misfire_grace_time=3600,
    )
    _scheduler.start()
    logger.info("APScheduler started; job '%s' at %02d:%02d IST", JOB_ID, hour, minute)
    # Fire catchup in the background so startup isn't blocked on a ~12-min pipeline
    asyncio.create_task(_catchup_if_missed())


async def reschedule(hour: int, minute: int) -> None:
    global _scheduler
    if not _scheduler:
        await start_scheduler()
        return
    _scheduler.reschedule_job(JOB_ID, trigger=CronTrigger(hour=hour, minute=minute, timezone=IST))
    logger.info("Rescheduled daily job to %02d:%02d IST", hour, minute)


def next_run_time() -> str | None:
    if not _scheduler:
        return None
    job = _scheduler.get_job(JOB_ID)
    if not job or not job.next_run_time:
        return None
    return job.next_run_time.astimezone(IST).isoformat()


async def stop_scheduler() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
