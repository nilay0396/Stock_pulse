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

function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `Rs ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function pct(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return escapeHtml(value);
  return `${n > 0 ? "+" : ""}${n}%`;
}

function range(low: unknown, high: unknown): string {
  const a = money(low);
  const b = money(high);
  return a === "-" && b === "-" ? "-" : `${a} - ${b}`;
}

function statusLabel(status: unknown): string {
  return String(status || "").replace(/_/g, " ");
}

function midpoint(low: unknown, high: unknown): number | null {
  const a = Number(low);
  const b = Number(high);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return (a + b) / 2;
}

function needsDataReview(item: any): boolean {
  const current = Number(item.current_price);
  const entryMid = midpoint(item.entry_low, item.entry_high);
  if (!Number.isFinite(current) || !entryMid) return false;
  const distance = Math.abs(current - entryMid) / entryMid;
  return distance >= 0.3 && item.status === "pending_entry";
}

function macroLine(context: Record<string, any>): string {
  const macro = context.macro || {};
  const parts = ["NIFTY", "BANKNIFTY", "INDIAVIX"].map((key) => {
    const m = macro[key];
    if (!m) return null;
    return `${key} ${m.last ?? "-"} (${pct(m.change_pct)})`;
  }).filter(Boolean);
  return parts.length ? parts.join(" | ") : "Market snapshot unavailable";
}

function ideaLines(idea: any): string[] {
  const conviction = idea.effective_conviction ?? idea.horizon_conviction ?? idea.conviction ?? "-";
  const dataScore = Number(idea.data_confidence_score);
  const dataLine = Number.isFinite(dataScore)
    ? `Data quality: ${dataScore}/100${idea.data_gaps?.length ? ` | Missing: ${escapeHtml(idea.data_gaps.slice(0, 2).join(", "))}` : ""}`
    : "";
  return [
    `<b>${escapeHtml(idea.symbol)}</b>${idea.name ? ` - ${escapeHtml(idea.name)}` : ""}`,
    `Action: New ${escapeHtml(idea.horizon || "trade")} setup (${escapeHtml(idea.direction || "watch")})`,
    `Conviction: ${escapeHtml(conviction)} | R:R ${escapeHtml(idea.risk_reward ?? "-")}${idea.fno_score !== undefined ? ` | F&O ${escapeHtml(idea.fno_score)}/100` : ""}`,
    dataLine,
    `Entry zone: ${escapeHtml(range(idea.entry_low, idea.entry_high))}`,
    `Stop: ${escapeHtml(money(idea.stop_loss))}`,
    `Target 1: ${escapeHtml(money(idea.target_low))} | Target 2: ${escapeHtml(money(idea.target_high))}`,
    idea.rationale ? `Why: ${escapeHtml(String(idea.rationale).replace(/\s+/g, " ").slice(0, 360))}` : "",
  ].filter(Boolean);
}

function pendingLines(item: any): string[] {
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Action: WAIT FOR ENTRY. Do not chase.`,
    `Current: ${escapeHtml(money(item.current_price))} | Return: ${escapeHtml(item.return_range_text || pct(item.return_pct))}`,
    `Entry zone: ${escapeHtml(range(item.entry_low, item.entry_high))}`,
    `Stop if entered: ${escapeHtml(money(item.stop_loss))}`,
    `Target 1: ${escapeHtml(money(item.target_low))} | Target 2: ${escapeHtml(money(item.target_high))}`,
    `Age: ${escapeHtml(item.days_active ?? 0)}d | Validity: ${escapeHtml(item.horizon || "-")}`,
  ];
}

function activeLines(item: any): string[] {
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Action: HOLD / MANAGE.`,
    `Entry: ${escapeHtml(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}${item.entry_date ? ` on ${escapeHtml(item.entry_date)}` : ""}`,
    `Current: ${escapeHtml(money(item.current_price))} | Return: ${escapeHtml(item.return_range_text || pct(item.return_pct))}`,
    `Stop: ${escapeHtml(money(item.stop_loss))}`,
    `Target 1: ${escapeHtml(money(item.target_low))} | Target 2: ${escapeHtml(money(item.target_high))}`,
    `Rule: Hold while above stop. Exit if stop hits. Review if fresh earnings/news/corporate-action risk appears.`,
    `Age: ${escapeHtml(item.days_active ?? 0)}d | Horizon: ${escapeHtml(item.horizon || "-")}`,
  ];
}

function trailingLines(item: any): string[] {
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Action: TARGET 1 DONE. Booked ${escapeHtml(item.partial_exit_pct ?? 50)}%; trail balance.`,
    `Original entry: ${escapeHtml(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}${item.entry_date ? ` on ${escapeHtml(item.entry_date)}` : ""}`,
    `Target 1 achieved: ${escapeHtml(money(item.target1_price || item.target_low))}${item.target1_date ? ` on ${escapeHtml(item.target1_date)}` : ""}`,
    `Current: ${escapeHtml(money(item.current_price))} | Return: ${escapeHtml(item.return_range_text || pct(item.return_pct))}`,
    `Trailing stop: ${escapeHtml(money(item.trailing_stop || item.entry_price || item.entry_low))}`,
    `Final target: ${escapeHtml(money(item.target_high))}`,
    `Exit balance if price closes below trailing stop or final target hits.`,
  ];
}

function resolvedLines(item: any): string[] {
  const status = String(item.status || "");
  const action = status === "hit_target"
    ? "FINAL TARGET HIT. Trade complete."
    : status === "hit_trailing_stop"
      ? "TRAILING STOP HIT. Balance closed."
      : status === "hit_stop"
        ? "STOP HIT. Trade closed."
        : status === "no_entry"
          ? "NO ENTRY. Trade not taken."
          : "CLOSED / EXPIRED. Review only.";
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Outcome: ${escapeHtml(action)}`,
    `Status: ${escapeHtml(statusLabel(item.status))}`,
    `Entry: ${escapeHtml(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}`,
    `Exit: ${escapeHtml(money(item.exit_price || item.current_price))}${item.exit_date ? ` on ${escapeHtml(item.exit_date)}` : ""}`,
    `Return: ${escapeHtml(item.return_range_text || pct(item.return_pct))}`,
  ];
}

function dataReviewLines(item: any): string[] {
  return [
    `<b>${escapeHtml(item.symbol)}</b>${item.name ? ` - ${escapeHtml(item.name)}` : ""}`,
    `Action: DO NOT TRADE`,
    `Current: ${escapeHtml(money(item.current_price))}`,
    `Stored entry zone: ${escapeHtml(range(item.entry_low, item.entry_high))}`,
    `Reason: entry zone does not match current price. Needs manual review before any action.`,
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
      for (let i = 0; i < line.length; i += TELEGRAM_MAX_MESSAGE) messages.push(line.slice(i, i + TELEGRAM_MAX_MESSAGE));
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
  const activeAll = Array.isArray(followups.active) ? followups.active : [];
  const resolved = Array.isArray(followups.resolved) ? followups.resolved : [];
  const dataReview = activeAll.filter((x: any) => needsDataReview(x));
  const pending = activeAll.filter((x: any) => x.status === "pending_entry" && !needsDataReview(x));
  const trailing = activeAll.filter((x: any) => x.status === "target_1_hit" || x.status === "trailing");
  const active = activeAll.filter((x: any) => x.status === "active");
  const newIdeas = [...weekly, ...monthly];

  const blocks: string[] = [];
  const push = (block: string[] | string) => blocks.push(Array.isArray(block) ? block.filter(Boolean).join("\n") : block);

  push([
    `<b>MARKET PULSE INDIA</b>`,
    `<b>Decision Report - ${escapeHtml(context.run_date)}</b>`,
    escapeHtml(macroLine(context)),
    "",
    `<b>Action Summary</b>`,
    `New setups today: ${newIdeas.length} (${weekly.length} weekly, ${monthly.length} monthly)`,
    `Entered positions to manage: ${active.length}`,
    `Target-1/trailing positions: ${trailing.length}`,
    `Pending entry watchlist: ${pending.length}`,
    `Data review / not actionable: ${dataReview.length}`,
    `Resolved today: ${resolved.length}`,
  ]);

  push("<b>1. New Setups Today</b>");
  if (newIdeas.length) {
    for (const idea of newIdeas) push(ideaLines(idea));
  } else {
    push("No new weekly or monthly entries today. Do not force a fresh trade; manage existing plans below.");
  }

  push("<b>2. Manage Entered Positions</b>");
  if (active.length) {
    for (const item of active) push(activeLines(item));
  } else {
    push("No entered positions need normal hold/stop management.");
  }

  push("<b>3. Target-1 Hit / Trailing Balance</b>");
  if (trailing.length) {
    for (const item of trailing) push(trailingLines(item));
  } else {
    push("No target-1/trailing positions today.");
  }

  push("<b>4. Pending Entry Watchlist</b>");
  if (pending.length) {
    for (const item of pending) push(pendingLines(item));
  } else {
    push("No pending entries.");
  }

  push("<b>5. Data Review / Not Actionable</b>");
  if (dataReview.length) {
    for (const item of dataReview) push(dataReviewLines(item));
  } else {
    push("No stale price-scale mismatches detected.");
  }

  push("<b>6. Resolved Since Last Report</b>");
  if (resolved.length) {
    for (const item of resolved) push(resolvedLines(item));
  } else {
    push("No plans resolved since the last report.");
  }

  push([
    "<b>Rule</b>",
    "Fresh trades come only from New Setups. Follow-ups are for managing old recommendations, not new entries unless they are in Pending Entry and price enters the zone. Data Review items are not tradeable.",
  ]);

  return splitMessages(blocks);
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
