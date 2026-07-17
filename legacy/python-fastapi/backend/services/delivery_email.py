"""Gmail SMTP delivery with aiosmtplib. Dry-run when app-password is absent."""
from __future__ import annotations
import logging
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict

import aiosmtplib

from services.settings import get_all as get_settings

logger = logging.getLogger(__name__)


async def send_email(to_email: str, subject: str, html_body: str, text_body: str = "") -> Dict[str, Any]:
    settings = await get_settings()
    sender = settings.get("gmail_address") or ""
    password = settings.get("gmail_app_password") or ""
    host = settings.get("smtp_host") or "smtp.gmail.com"
    port = int(settings.get("smtp_port") or 587)
    from_name = settings.get("gmail_from_name") or "Market Pulse India"
    dry_run = settings.get("dry_run") or not sender or not password or not to_email

    if dry_run:
        logger.info("[DRY-RUN email] to=%s subject=%s html_len=%s", to_email, subject, len(html_body))
        return {
            "ok": True,
            "dry_run": True,
            "status": "dry_run",
            "reason": "missing_creds" if not (sender and password) else ("missing_to" if not to_email else "dry_run_enabled"),
        }

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{sender}>"
    msg["To"] = to_email
    if text_body:
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        context = ssl.create_default_context()
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=port,
            username=sender,
            password=password,
            start_tls=True,
            tls_context=context,
            timeout=30,
        )
        return {"ok": True, "dry_run": False, "status": "sent"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "dry_run": False, "status": "failed", "error": str(e)}


def render_email_html(ctx: Dict[str, Any]) -> str:
    macro = ctx.get("macro", {})
    run_date = ctx.get("run_date", "")

    def _html_escape(s: str) -> str:
        return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def macro_row(k, label):
        m = macro.get(k)
        if not m:
            return ""
        cp = m.get("change_pct", 0)
        color = "#00A36C" if cp >= 0 else "#DC2626"
        return f"""<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #1f1f24;color:#A1A1AA;font-family:Arial">{label}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;text-align:right">{m.get('last','—')}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #1f1f24;color:{color};font-family:monospace;text-align:right">{cp:+.2f}%</td>
        </tr>"""

    def ideas_rows(ideas):
        rows = []
        for i in ideas[:8]:
            d = i["direction"]
            color = "#00A36C" if d == "bullish" else ("#DC2626" if d == "bearish" else "#D97706")
            rows.append(f"""<tr>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;font-weight:bold">{i['symbol']}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:{color};font-family:monospace;text-transform:uppercase">{d}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#A1A1AA;font-family:Arial">{i.get('setup_type','')}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;text-align:right">₹{i['entry_low']}–{i['entry_high']}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;text-align:right">₹{i['stop_loss']}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;text-align:right">₹{i['target_low']}–{i['target_high']}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #1f1f24;color:#F4F4F5;font-family:monospace;text-align:right">{int(i['conviction'])}</td>
            </tr>""")
            if i.get("rationale"):
                rows.append(f"""<tr>
                  <td colspan="7" style="padding:4px 12px 14px 12px;border-bottom:1px solid #1f1f24;color:#D4D4D8;font-family:Arial;font-size:12.5px;line-height:1.55;font-style:italic">
                    {_html_escape(i['rationale'])}
                  </td>
                </tr>""")
        return "".join(rows) or '<tr><td colspan="7" style="padding:14px;color:#71717A;text-align:center">No high-conviction ideas today.</td></tr>'

    narrative = (ctx.get("narrative") or "").replace("\n", "<br/>")

    html = f"""<!doctype html>
    <html><body style="background:#050505;margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#F4F4F5">
    <div style="max-width:760px;margin:0 auto;background:#0C0C0E;border:1px solid #1F1F24;padding:28px">
      <div style="border-bottom:1px solid #1F1F24;padding-bottom:14px;margin-bottom:18px">
        <div style="font-size:11px;letter-spacing:0.2em;color:#71717A;text-transform:uppercase">Market Pulse India</div>
        <div style="font-size:24px;font-weight:900;margin-top:4px">Daily Morning Brief — {run_date}</div>
      </div>

      <h3 style="font-size:11px;letter-spacing:0.2em;color:#71717A;text-transform:uppercase;margin:18px 0 8px">Macro Snapshot</h3>
      <table style="width:100%;border-collapse:collapse">
        {macro_row('NIFTY','NIFTY 50')}
        {macro_row('BANKNIFTY','BANK NIFTY')}
        {macro_row('INDIAVIX','INDIA VIX')}
        {macro_row('USDINR','USD/INR')}
        {macro_row('SP500','S&amp;P 500')}
        {macro_row('DXY','Dollar Index')}
        {macro_row('CRUDE','Brent / Crude')}
        {macro_row('GOLD','Gold')}
      </table>

      <h3 style="font-size:11px;letter-spacing:0.2em;color:#71717A;text-transform:uppercase;margin:22px 0 8px">Weekly Trade Ideas</h3>
      <table style="width:100%;border-collapse:collapse;background:#141417">
        <thead>
          <tr style="background:#050505">
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">SYMBOL</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">DIR</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">SETUP</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">ENTRY</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">STOP</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">TARGET</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">CONV</th>
          </tr>
        </thead>
        <tbody>{ideas_rows(ctx.get('top_weekly') or [])}</tbody>
      </table>

      <h3 style="font-size:11px;letter-spacing:0.2em;color:#71717A;text-transform:uppercase;margin:22px 0 8px">Monthly Trade Ideas</h3>
      <table style="width:100%;border-collapse:collapse;background:#141417">
        <thead>
          <tr style="background:#050505">
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">SYMBOL</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">DIR</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;letter-spacing:0.15em;color:#71717A">SETUP</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">ENTRY</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">STOP</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">TARGET</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;letter-spacing:0.15em;color:#71717A">CONV</th>
          </tr>
        </thead>
        <tbody>{ideas_rows(ctx.get('top_monthly') or [])}</tbody>
      </table>

      <h3 style="font-size:11px;letter-spacing:0.2em;color:#71717A;text-transform:uppercase;margin:22px 0 8px">Strategist Note</h3>
      <div style="color:#E4E4E7;line-height:1.65;font-size:14px">{narrative}</div>

      <div style="margin-top:26px;padding-top:14px;border-top:1px solid #1F1F24;color:#71717A;font-size:11px;line-height:1.6">
        This report is for informational purposes only and is not investment advice.
        Past performance does not guarantee future returns. Consult a SEBI-registered advisor before trading.
      </div>
    </div></body></html>
    """
    return html
