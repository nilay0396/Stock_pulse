"""System-settings read/write helpers (Telegram/Gmail creds live here, editable via admin UI)."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from db import settings_col


DEFAULTS: Dict[str, Any] = {
    "telegram_bot_token": "",
    "telegram_default_chat_id": "",
    "gmail_address": "",
    "gmail_app_password": "",
    "gmail_from_name": "Market Pulse India",
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "report_hour": 7,
    "report_minute": 0,
    "dry_run": True,
    "fmp_api_key": "",
    "fred_api_key": "",
    # F&O broker credentials — each provider is skipped automatically when its
    # required field(s) are empty. See services/fno/providers.py.
    "UPSTOX_ACCESS_TOKEN": "",
    "FYERS_CLIENT_ID": "",
    "FYERS_ACCESS_TOKEN": "",
    # Explicit opt-in for NSE-direct F&O — off by default because NSE's Akamai
    # WAF 403s most data-centre IPs. Only flip true when running through a
    # residential-IP proxy.
    "FNO_ENABLE_NSE_DIRECT": "false",
}


async def get_all() -> Dict[str, Any]:
    docs = await settings_col.find({}, {"_id": 0}).to_list(200)
    merged = dict(DEFAULTS)
    for d in docs:
        merged[d["key"]] = d["value"]
    # auto-flip dry_run if creds missing
    if not merged.get("telegram_bot_token") and not merged.get("gmail_address"):
        merged["dry_run"] = True
    return merged


async def get(key: str, default: Any = None) -> Any:
    doc = await settings_col.find_one({"key": key}, {"_id": 0})
    if not doc:
        return DEFAULTS.get(key, default)
    return doc["value"]


async def set_many(values: Dict[str, Any]) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    for k, v in values.items():
        if v is None:
            continue
        await settings_col.update_one(
            {"key": k},
            {"$set": {"key": k, "value": v, "updated_at": now}},
            upsert=True,
        )
    return await get_all()


def mask_secrets(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Return settings with secret-ish fields masked for non-admin display."""
    out = dict(settings)
    for k in ("telegram_bot_token", "gmail_app_password",
              "UPSTOX_ACCESS_TOKEN", "FYERS_ACCESS_TOKEN"):
        v = out.get(k) or ""
        if v:
            out[k] = v[:4] + "•" * max(0, len(v) - 6) + v[-2:] if len(v) > 6 else "••••"
    return out
