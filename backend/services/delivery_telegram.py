"""Telegram delivery. Dry-run when bot token is absent."""
from __future__ import annotations
import logging
from typing import Any, Dict, Optional

import httpx

from services.settings import get_all as get_settings

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


async def send_telegram(chat_id: str, text: str, parse_mode: str = "HTML") -> Dict[str, Any]:
    settings = await get_settings()
    token = settings.get("telegram_bot_token") or ""
    dry_run = settings.get("dry_run") or not token or not chat_id

    if dry_run:
        logger.info("[DRY-RUN telegram] chat_id=%s text_len=%s", chat_id, len(text))
        return {
            "ok": True,
            "dry_run": True,
            "status": "dry_run",
            "reason": "missing_token" if not token else ("missing_chat_id" if not chat_id else "dry_run_enabled"),
        }

    url = TELEGRAM_API.format(token=token)
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(url, json=payload)
            data = resp.json()
            if resp.status_code == 200 and data.get("ok"):
                return {"ok": True, "dry_run": False, "status": "sent", "message_id": data.get("result", {}).get("message_id")}
            return {"ok": False, "dry_run": False, "status": "failed", "error": data.get("description") or f"HTTP {resp.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "dry_run": False, "status": "failed", "error": str(e)}


def format_telegram_summary(ctx: Dict[str, Any]) -> str:
    """Short HTML summary meant for Telegram morning ping."""
    macro = ctx.get("macro", {})
    nifty = macro.get("NIFTY", {})
    banknifty = macro.get("BANKNIFTY", {})
    vix = macro.get("INDIAVIX", {})
    usdinr = macro.get("USDINR", {})
    parts = [
        "<b>📈 Market Pulse India — Morning Brief</b>",
        f"🗓 {ctx.get('run_date','')}",
        "",
        "<b>India Macro</b>",
        f"• NIFTY {nifty.get('last','—')} ({nifty.get('change_pct',0):+.2f}%)" if nifty else "",
        f"• BANKNIFTY {banknifty.get('last','—')} ({banknifty.get('change_pct',0):+.2f}%)" if banknifty else "",
        f"• INDIAVIX {vix.get('last','—')} ({vix.get('change_pct',0):+.2f}%)" if vix else "",
        f"• USDINR {usdinr.get('last','—')} ({usdinr.get('change_pct',0):+.2f}%)" if usdinr else "",
        "",
        f"<b>Bullish sectors:</b> {', '.join(ctx.get('bullish_sectors', [])) or '—'}",
        f"<b>Cautious:</b> {', '.join(ctx.get('cautious_sectors', [])) or '—'}",
        "",
        "<b>Top Weekly Ideas</b>",
    ]
    for i in (ctx.get("top_weekly") or [])[:5]:
        parts.append(f"• <b>{i['symbol']}</b> — {i['direction'].upper()} @ ₹{i['entry_low']}–{i['entry_high']} (conv {int(i['conviction'])})")
        if i.get("rationale"):
            parts.append(f"  <i>{_truncate(i['rationale'], 280)}</i>")
    parts.append("")
    parts.append("<b>Top Monthly Ideas</b>")
    for i in (ctx.get("top_monthly") or [])[:5]:
        parts.append(f"• <b>{i['symbol']}</b> — {i['direction'].upper()} @ ₹{i['entry_low']}–{i['entry_high']} (conv {int(i['conviction'])})")
        if i.get("rationale"):
            parts.append(f"  <i>{_truncate(i['rationale'], 280)}</i>")
    parts.append("")
    parts.append("<i>Full report delivered via email. Not investment advice.</i>")
    return "\n".join([p for p in parts if p is not None])


def _truncate(s: str, n: int) -> str:
    s = (s or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"
