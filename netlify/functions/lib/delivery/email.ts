import nodemailer from "nodemailer";
import { asBoolean, asString, type SystemSettings } from "../settings.js";

type SendResult = {
  ok: boolean;
  status: "sent" | "dry_run" | "failed" | "skipped";
  error?: string;
  response_meta?: Record<string, unknown>;
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ideaRows(ideas: any[]): string {
  return ideas.map((idea) => `
    <tr>
      <td><strong>${esc(idea.symbol)}</strong><br><span>${esc(idea.name || idea.sector || "")}</span></td>
      <td>${esc(idea.direction)}</td>
      <td>${esc(idea.conviction)}</td>
      <td>${esc(idea.entry_low)} - ${esc(idea.entry_high)}</td>
      <td>${esc(idea.stop_loss)}</td>
      <td>${esc(idea.target_low)} - ${esc(idea.target_high)}</td>
    </tr>
  `).join("");
}

export function renderReportEmail(context: Record<string, any>): string {
  const weekly = Array.isArray(context.top_weekly) ? context.top_weekly : [];
  const monthly = Array.isArray(context.top_monthly) ? context.top_monthly : [];
  return `<!doctype html>
  <html>
    <body style="margin:0;background:#08090b;color:#f4f4f5;font-family:Arial,sans-serif">
      <div style="max-width:860px;margin:0 auto;padding:28px">
        <p style="letter-spacing:3px;color:#9ca3af;font-size:11px;margin:0 0 8px">MARKET PULSE INDIA</p>
        <h1 style="margin:0 0 8px;font-size:30px">Daily Report - ${esc(context.run_date)}</h1>
        <p style="color:#d4d4d8;line-height:1.6">${esc(context.narrative || "Report generated successfully.")}</p>
        <h2 style="font-size:18px;margin-top:28px">Weekly Ideas</h2>
        <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;color:#f4f4f5">
          <thead><tr style="color:#9ca3af;text-align:left"><th>Symbol</th><th>Direction</th><th>Conviction</th><th>Entry</th><th>Stop</th><th>Target</th></tr></thead>
          <tbody>${ideaRows(weekly)}</tbody>
        </table>
        <h2 style="font-size:18px;margin-top:28px">Monthly Ideas</h2>
        <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;color:#f4f4f5">
          <thead><tr style="color:#9ca3af;text-align:left"><th>Symbol</th><th>Direction</th><th>Conviction</th><th>Entry</th><th>Stop</th><th>Target</th></tr></thead>
          <tbody>${monthly.length ? ideaRows(monthly) : `<tr><td colspan="6" style="color:#9ca3af">No monthly ideas for this run.</td></tr>`}</tbody>
        </table>
      </div>
    </body>
  </html>`;
}

export function renderReportText(context: Record<string, any>): string {
  const weekly = Array.isArray(context.top_weekly) ? context.top_weekly : [];
  return [
    `Market Pulse India - ${context.run_date}`,
    context.narrative || "",
    "",
    ...weekly.map((idea) => `${idea.symbol} ${idea.direction} conviction ${idea.conviction} entry ${idea.entry_low}-${idea.entry_high}`),
  ].join("\n");
}

export async function sendEmail(
  settings: SystemSettings,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<SendResult> {
  const user = asString(settings, "gmail_address");
  const pass = asString(settings, "gmail_app_password");
  if (!to) return { ok: false, status: "skipped", error: "Missing email recipient" };
  if (asBoolean(settings, "dry_run") || !user || !pass) {
    return { ok: true, status: "dry_run", response_meta: { dry_run: true, reason: user && pass ? "settings" : "missing_credentials" } };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    const info = await transporter.sendMail({
      from: `"${asString(settings, "gmail_from_name") || "Market Pulse India"}" <${user}>`,
      to,
      subject,
      html,
      text,
    });
    return { ok: true, status: "sent", response_meta: { message_id: info.messageId } };
  } catch (err) {
    return { ok: false, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
