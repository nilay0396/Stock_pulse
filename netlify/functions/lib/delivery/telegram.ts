import { asBoolean, asString, type SystemSettings } from "../settings.js";

type SendResult = {
  ok: boolean;
  status: "sent" | "dry_run" | "failed" | "skipped";
  error?: string;
  response_meta?: Record<string, unknown>;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatTelegramReport(context: Record<string, any>): string {
  const weekly = Array.isArray(context.top_weekly) ? context.top_weekly.slice(0, 5) : [];
  const monthly = Array.isArray(context.top_monthly) ? context.top_monthly.slice(0, 3) : [];
  const funnel = context.funnel || {};
  const lines = [
    `<b>Market Pulse India</b>`,
    `<b>${escapeHtml(context.run_date)}</b> | screened ${escapeHtml(funnel.pool ?? context.universe_count ?? "-")} | ideas ${weekly.length + monthly.length}`,
    "",
  ];

  if (context.narrative) lines.push(escapeHtml(String(context.narrative).slice(0, 650)), "");

  if (weekly.length) {
    lines.push("<b>Weekly</b>");
    for (const idea of weekly) {
      lines.push(`${escapeHtml(idea.symbol)} ${escapeHtml(idea.direction)} | ${escapeHtml(idea.conviction)} | ${escapeHtml(idea.entry_low)}-${escapeHtml(idea.entry_high)}`);
    }
  }

  if (monthly.length) {
    lines.push("", "<b>Monthly</b>");
    for (const idea of monthly) {
      lines.push(`${escapeHtml(idea.symbol)} ${escapeHtml(idea.direction)} | ${escapeHtml(idea.conviction)} | ${escapeHtml(idea.entry_low)}-${escapeHtml(idea.entry_high)}`);
    }
  }

  const text = lines.join("\n").trim();
  return text.length > 3900 ? `${text.slice(0, 3890)}\n...` : text;
}

export async function sendTelegram(
  settings: SystemSettings,
  chatId: string,
  text: string,
): Promise<SendResult> {
  const token = asString(settings, "telegram_bot_token");
  if (!chatId) return { ok: false, status: "skipped", error: "Missing Telegram chat ID" };
  if (asBoolean(settings, "dry_run") || !token) {
    return { ok: true, status: "dry_run", response_meta: { dry_run: true, reason: token ? "settings" : "missing_token" } };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || body.ok === false) {
      return { ok: false, status: "failed", error: body.description || `Telegram HTTP ${res.status}`, response_meta: { http_status: res.status } };
    }
    return { ok: true, status: "sent", response_meta: { message_id: body.result?.message_id } };
  } catch (err) {
    return { ok: false, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getTelegramBotInfo(settings: SystemSettings): Promise<Record<string, unknown>> {
  const token = asString(settings, "telegram_bot_token");
  if (!token) throw new Error("Telegram bot token is not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || body.ok === false) throw new Error(body.description || `Telegram HTTP ${res.status}`);
  return body.result;
}

export async function discoverTelegramChats(settings: SystemSettings): Promise<Record<string, unknown>[]> {
  const token = asString(settings, "telegram_bot_token");
  if (!token) throw new Error("Telegram bot token is not configured");
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || body.ok === false) throw new Error(body.description || `Telegram HTTP ${res.status}`);

  const byChat = new Map<string, Record<string, unknown>>();
  for (const update of body.result || []) {
    const msg = update.message || update.channel_post || update.edited_message;
    const chat = msg?.chat;
    if (!chat?.id) continue;
    byChat.set(String(chat.id), {
      chat_id: chat.id,
      first_name: chat.first_name || "",
      last_name: chat.last_name || "",
      title: chat.title || "",
      username: chat.username || "",
      type: chat.type || "",
      last_text: msg.text || "",
    });
  }
  return [...byChat.values()];
}
