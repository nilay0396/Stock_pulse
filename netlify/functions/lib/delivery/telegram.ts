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

const TELEGRAM_MAX_MESSAGE = 3800;

function ideaLines(idea: any): string[] {
  return [
    `<b>${escapeHtml(idea.symbol)}</b>${idea.name ? ` - ${escapeHtml(idea.name)}` : ""}`,
    `Direction: ${escapeHtml(idea.direction)}`,
    `Conviction: ${escapeHtml(idea.conviction)}`,
    `Entry: ${escapeHtml(idea.entry_low)} - ${escapeHtml(idea.entry_high)}`,
    `Stop: ${escapeHtml(idea.stop_loss)}`,
    `Target: ${escapeHtml(idea.target_low)} - ${escapeHtml(idea.target_high)}`,
  ];
}

function returnText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return escapeHtml(value);
  return `${n > 0 ? "+" : ""}${n}%`;
}

function followupLines(item: any): string[] {
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Status: ${escapeHtml(item.status)}`,
    `Current: ${escapeHtml(item.current_price ?? "—")} | Return: ${returnText(item.return_pct)}`,
    `Days active: ${escapeHtml(item.days_active ?? 0)}`,
    escapeHtml(item.ai_followup || item.status_note || ""),
  ];
}

function splitMessages(lines: string[]): string[] {
  const messages: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) messages.push(current.trim());
    current = "";
  };

  for (const line of lines) {
    if (line.length > TELEGRAM_MAX_MESSAGE) {
      pushCurrent();
      for (let i = 0; i < line.length; i += TELEGRAM_MAX_MESSAGE) {
        messages.push(line.slice(i, i + TELEGRAM_MAX_MESSAGE));
      }
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > TELEGRAM_MAX_MESSAGE) {
      pushCurrent();
      current = line;
    } else {
      current = next;
    }
  }
  pushCurrent();
  return messages.length ? messages : ["Report generated successfully."];
}

export function formatTelegramReport(context: Record<string, any>): string[] {
  const weekly = Array.isArray(context.top_weekly) ? context.top_weekly : [];
  const monthly = Array.isArray(context.top_monthly) ? context.top_monthly : [];
  const followups = context.followups || {};
  const activeFollowups = Array.isArray(followups.active) ? followups.active : [];
  const resolvedFollowups = Array.isArray(followups.resolved) ? followups.resolved : [];
  const lines = [
    `<b>MARKET PULSE INDIA</b>`,
    `<b>Daily Report - ${escapeHtml(context.run_date)}</b>`,
    "",
  ];

  lines.push(escapeHtml(context.narrative || "Report generated successfully."), "");

  lines.push("<b>Weekly Ideas</b>");
  if (weekly.length) {
    for (const idea of weekly) {
      lines.push(...ideaLines(idea), "");
    }
  } else {
    lines.push("No weekly ideas for this run.", "");
  }

  lines.push("<b>Monthly Ideas</b>");
  if (monthly.length) {
    for (const idea of monthly) {
      lines.push(...ideaLines(idea), "");
    }
  } else {
    lines.push("No monthly ideas for this run.");
  }

  lines.push("", "<b>Active Follow-ups</b>");
  if (activeFollowups.length) {
    for (const item of activeFollowups) {
      lines.push(...followupLines(item), "");
    }
  } else {
    lines.push("No active follow-ups yet.", "");
  }

  lines.push("<b>Resolved Follow-ups</b>");
  if (resolvedFollowups.length) {
    for (const item of resolvedFollowups) {
      lines.push(...followupLines(item), "");
    }
  } else {
    lines.push("No recommendations resolved in this run.");
  }

  return splitMessages(lines);
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
