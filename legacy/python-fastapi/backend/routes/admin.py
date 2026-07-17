"""Admin-only routes: connectors, ingestion, deliveries, settings, users, test-sends."""
import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth import require_admin, hash_password
from connectors import registry
from connectors.market_data import EquityHistoryConnector, MacroConnector, NewsConnector
from db import (
    audit_col, connectors_col, deliveries_col, ingestion_runs_col,
    preferences_col, stock_universe_col, users_col,
)
from models import SettingsUpdate
from scheduler import next_run_time, reschedule
from services import delivery_email, delivery_telegram, settings as settings_svc
from stock_universe import seed_universe

router = APIRouter(prefix="/admin", tags=["admin"])


async def _audit(user: dict, action: str, meta: Optional[dict] = None) -> None:
    import uuid
    await audit_col.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user["id"], "email": user["email"], "action": action,
        "meta": meta or {}, "at": datetime.now(timezone.utc).isoformat(),
    })


# ---------- Connectors ----------
@router.get("/connectors")
async def get_connectors(_: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    return await registry.health_snapshot()


@router.post("/connectors/{name}/run")
async def run_connector(name: str, user: dict = Depends(require_admin)) -> Dict[str, Any]:
    conn = registry.get(name)
    if not conn:
        raise HTTPException(404, "Connector not found")

    await _audit(user, f"run_connector:{name}")
    if name in ("yfinance_equities", "fmp_fundamentals", "nse_shareholding"):
        uni = await stock_universe_col.find({}, {"_id": 0, "yf_symbol": 1, "symbol": 1}).to_list(500)
        if name == "yfinance_equities":
            tickers = [u["yf_symbol"] for u in uni]
            return await conn.run(tickers=tickers[:20], period="1mo", interval="1d")
        else:
            return await conn.run(symbols=[u["symbol"] for u in uni][:10])
    if name == "nse_quote":
        uni = await stock_universe_col.find({}, {"_id": 0, "symbol": 1}).to_list(500)
        return await conn.run(symbols=[u["symbol"] for u in uni][:8])
    if name == "yfinance_news":
        uni = await stock_universe_col.find_one({}, {"_id": 0, "yf_symbol": 1})
        if not uni:
            raise HTTPException(400, "No universe seeded")
        return await conn.run(ticker=uni["yf_symbol"])
    return await conn.run()


@router.get("/ingestion-runs")
async def ingestion_runs(limit: int = 50, _: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    return await ingestion_runs_col.find({}, {"_id": 0}).sort("started_at", -1).to_list(limit)


# ---------- Deliveries / Logs ----------
@router.get("/deliveries")
async def deliveries(limit: int = 100, _: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    return await deliveries_col.find({}, {"_id": 0}).sort("created_at", -1).to_list(limit)


@router.get("/audit")
async def audit_logs(limit: int = 100, _: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    return await audit_col.find({}, {"_id": 0}).sort("at", -1).to_list(limit)


# ---------- Settings ----------
@router.get("/settings")
async def get_settings(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    return await settings_svc.get_all()


@router.put("/settings")
async def update_settings(body: SettingsUpdate, user: dict = Depends(require_admin)) -> Dict[str, Any]:
    updated = await settings_svc.set_many({k: v for k, v in body.model_dump().items() if v is not None})
    await _audit(user, "update_settings", {"keys": list(body.model_dump(exclude_none=True).keys())})
    # reschedule if timing changed
    if body.report_hour is not None or body.report_minute is not None:
        await reschedule(int(updated["report_hour"]), int(updated["report_minute"]))
    return updated


# ---------- Test sends ----------
@router.post("/test/telegram")
async def test_telegram(body: Dict[str, Any], user: dict = Depends(require_admin)) -> Dict[str, Any]:
    chat_id = body.get("chat_id") or ""
    text = body.get("text") or "<b>Market Pulse India — test ping</b>\nThis confirms your Telegram wiring."
    res = await delivery_telegram.send_telegram(chat_id, text)
    await _audit(user, "test_telegram", {"chat_id": chat_id, "status": res.get("status")})
    return res


@router.get("/telegram/discover")
async def discover_telegram_chats(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    """Poll Telegram getUpdates and return the list of chats that have messaged the bot.

    Users must `/start` the bot once before their chat_id shows up here.
    """
    settings = await settings_svc.get_all()
    token = settings.get("telegram_bot_token") or ""
    if not token:
        raise HTTPException(400, "Telegram bot token is not configured")
    url = f"https://api.telegram.org/bot{token}/getUpdates"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url)
            data = resp.json()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Telegram API error: {e}")

    if not data.get("ok"):
        raise HTTPException(502, f"Telegram error: {data.get('description')}")

    chats: Dict[int, Dict[str, Any]] = {}
    for upd in data.get("result") or []:
        msg = upd.get("message") or upd.get("edited_message") or upd.get("channel_post") or {}
        chat = msg.get("chat") or {}
        cid = chat.get("id")
        if cid is None:
            continue
        frm = msg.get("from") or {}
        chats[cid] = {
            "chat_id": cid,
            "type": chat.get("type"),
            "title": chat.get("title"),
            "username": chat.get("username") or frm.get("username"),
            "first_name": chat.get("first_name") or frm.get("first_name"),
            "last_name": chat.get("last_name") or frm.get("last_name"),
            "last_text": msg.get("text"),
        }
    return {"bot_configured": True, "count": len(chats), "chats": list(chats.values())}


@router.post("/telegram/get-bot-info")
async def telegram_bot_info(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    settings = await settings_svc.get_all()
    token = settings.get("telegram_bot_token") or ""
    if not token:
        raise HTTPException(400, "Telegram bot token is not configured")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"https://api.telegram.org/bot{token}/getMe")
            data = r.json()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Telegram API error: {e}")
    if not data.get("ok"):
        raise HTTPException(400, f"Invalid bot token: {data.get('description')}")
    return data.get("result") or {}


@router.post("/test/email")
async def test_email(body: Dict[str, Any], user: dict = Depends(require_admin)) -> Dict[str, Any]:
    to_email = body.get("to") or user["email"]
    subject = body.get("subject") or "Market Pulse India — test email"
    html_body = body.get("html") or "<p>This is a test email from Market Pulse India.</p>"
    res = await delivery_email.send_email(to_email, subject, html_body)
    await _audit(user, "test_email", {"to": to_email, "status": res.get("status")})
    return res


# ---------- Users ----------
@router.get("/users")
async def list_users(_: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    docs = await users_col.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    # enrich with prefs
    for d in docs:
        p = await preferences_col.find_one({"user_id": d["id"]}, {"_id": 0})
        d["preferences"] = p or {}
    return docs


@router.post("/users/{user_id}/role")
async def set_role(user_id: str, body: Dict[str, Any], user: dict = Depends(require_admin)) -> Dict[str, Any]:
    role = body.get("role")
    if role not in ("user", "admin"):
        raise HTTPException(400, "role must be user|admin")
    await users_col.update_one({"id": user_id}, {"$set": {"role": role}})
    await _audit(user, "set_role", {"target": user_id, "role": role})
    return {"ok": True}


@router.post("/users/{user_id}/reset-password")
async def reset_password(user_id: str, body: Dict[str, Any], user: dict = Depends(require_admin)) -> Dict[str, Any]:
    new_pw = body.get("password")
    if not new_pw or len(new_pw) < 6:
        raise HTTPException(400, "password too short")
    await users_col.update_one({"id": user_id}, {"$set": {"password_hash": hash_password(new_pw)}})
    await _audit(user, "reset_password", {"target": user_id})
    return {"ok": True}


# ---------- Seeding ----------
@router.post("/seed-universe")
async def reseed_universe(user: dict = Depends(require_admin)) -> Dict[str, Any]:
    n = await seed_universe()
    await _audit(user, "seed_universe", {"inserted": n})
    count = await stock_universe_col.count_documents({})
    return {"inserted": n, "total": count}


@router.post("/seed-full-universe")
async def reseed_full_universe(user: dict = Depends(require_admin)) -> Dict[str, Any]:
    """Pull EQUITY_L master list from NSE and bulk-seed the full ~2,000-stock
    universe used by the Stage-1 funnel. Hand-curated sector tags are
    preserved on existing entries."""
    from stock_universe import seed_full_nse_universe
    res = await seed_full_nse_universe()
    await _audit(user, "seed_full_universe", res)
    return res


# ---------- Scheduler ----------
@router.get("/scheduler")
async def scheduler_status(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    s = await settings_svc.get_all()
    return {
        "report_hour": s.get("report_hour"),
        "report_minute": s.get("report_minute"),
        "next_run": next_run_time(),
    }



# ---------- Backtest harness ----------
@router.post("/backtest/run")
async def run_backtest(report_run_id: str, user: dict = Depends(require_admin)) -> Dict[str, Any]:
    """Replay every idea attached to a past report_run_id on calendar-forward
    price data and return aggregated hit-rate + per-trade outcomes."""
    from services import backtest as backtest_svc
    try:
        doc = await backtest_svc.backtest_report_run(report_run_id, triggered_by=user["email"])
    except ValueError as e:
        raise HTTPException(404, str(e))
    await _audit(user, "backtest_run", {"report_run_id": report_run_id, "backtest_id": doc.get("id")})
    return doc


@router.get("/backtest/runs")
async def list_backtests(_: dict = Depends(require_admin), limit: int = 50) -> List[Dict[str, Any]]:
    from services import backtest as backtest_svc
    return await backtest_svc.list_backtest_runs(limit=limit)


@router.get("/backtest/{backtest_id}")
async def get_backtest(backtest_id: str, _: dict = Depends(require_admin)) -> Dict[str, Any]:
    from services import backtest as backtest_svc
    doc = await backtest_svc.get_backtest_run(backtest_id)
    if not doc:
        raise HTTPException(404, "Backtest run not found")
    return doc
