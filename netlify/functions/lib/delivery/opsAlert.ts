import { asString, loadSystemSettings } from "../settings.js";
import { sendEmail } from "./email.js";
import { sendTelegram } from "./telegram.js";

export async function sendOpsAlert(subject: string, message: string): Promise<void> {
  try {
    const settings = await loadSystemSettings();
    const chatId = process.env.OPS_ALERT_TELEGRAM_CHAT_ID || asString(settings, "telegram_default_chat_id");
    const emailTo = process.env.OPS_ALERT_EMAIL || asString(settings, "gmail_address");
    const text = `[Market Pulse Alert]\n${subject}\n\n${message}`;

    const sends: Promise<unknown>[] = [];
    if (chatId) sends.push(sendTelegram(settings, chatId, `<b>Market Pulse Alert</b>\n${subject}\n\n${message}`));
    if (emailTo) sends.push(sendEmail(settings, emailTo, `Market Pulse Alert - ${subject}`, `<pre>${escapeHtml(text)}</pre>`, text));
    await Promise.allSettled(sends);
  } catch (err) {
    console.warn("ops alert warning:", err instanceof Error ? err.message : err);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
