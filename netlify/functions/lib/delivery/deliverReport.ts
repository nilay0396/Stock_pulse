import { db } from "../db.js";
import { asBoolean, asString, loadSystemSettings } from "../settings.js";
import { formatTelegramReport, sendTelegram } from "./telegram.js";
import { renderReportEmail, renderReportText, sendEmail } from "./email.js";

type DeliveryResult = { attempted: number; sent: number; dry_run: number; failed: number; skipped: number };
type DeliveryStatus = "sent" | "dry_run" | "failed" | "skipped";
type ChannelResult = { ok: boolean; status: DeliveryStatus; error?: string; response_meta?: Record<string, unknown> };

const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

function isDeliverableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  const domain = trimmed.split("@")[1] || "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && !RESERVED_EMAIL_DOMAINS.has(domain);
}

async function logDelivery(row: {
  report_run_id: string;
  user_id?: string | null;
  channel: "telegram" | "email";
  recipient: string;
  status: "sent" | "failed" | "dry_run" | "skipped";
  error?: string;
  response_meta?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db.from("delivery_logs").insert({
    ...row,
    response_meta: row.response_meta || {},
  });
  if (error) console.warn("delivery log insert warning:", error.message);
}

async function loadReportContext(reportRunId: string): Promise<Record<string, any> | null> {
  const { data, error } = await db
    .from("report_runs")
    .select("id,run_date,summary,narrative,status")
    .eq("id", reportRunId)
    .maybeSingle();
  if (error || !data || data.status !== "success") return null;
  return {
    ...((data.summary as Record<string, any>) || {}),
    run_id: data.id,
    run_date: data.run_date,
    narrative: data.narrative,
  };
}

export async function deliverReport(reportRunId: string): Promise<DeliveryResult> {
  const result: DeliveryResult = { attempted: 0, sent: 0, dry_run: 0, failed: 0, skipped: 0 };
  const context = await loadReportContext(reportRunId);
  if (!context) return result;

  const settings = await loadSystemSettings();
  const { data: users, error: userError } = await db.from("users").select("id,email");
  const { data: prefs, error: prefError } = await db.from("user_preferences").select("*");
  if (userError || prefError) throw new Error(userError?.message || prefError?.message || "Failed to load delivery recipients");

  const prefsByUser = new Map((prefs || []).map((p) => [p.user_id, p]));
  const dryRun = asBoolean(settings, "dry_run");
  const subject = `Market Pulse India - ${context.run_date}`;
  const html = renderReportEmail(context);
  const text = renderReportText(context);

  const telegramRecipients = new Map<string, string | null>();
  for (const user of users || []) {
    const pref = prefsByUser.get(user.id);
    if (pref?.telegram_alerts && pref.telegram_chat_id) telegramRecipients.set(String(pref.telegram_chat_id), user.id);
  }
  const defaultChat = asString(settings, "telegram_default_chat_id");
  if (defaultChat) telegramRecipients.set(defaultChat, null);

  const telegramMessages = formatTelegramReport(context);
  for (const [chatId, userId] of telegramRecipients) {
    result.attempted += 1;
    let res: ChannelResult = { ok: true, status: "sent", response_meta: { message_count: 0 } };
    const messageIds: unknown[] = [];
    for (const message of telegramMessages) {
      const partRes = await sendTelegram(settings, chatId, message);
      if (partRes.response_meta?.message_id) messageIds.push(partRes.response_meta.message_id);
      res = {
        ok: partRes.ok,
        status: partRes.status,
        error: partRes.error,
        response_meta: {
          ...(partRes.response_meta || {}),
          message_count: telegramMessages.length,
          message_ids: messageIds,
        },
      };
      if (!partRes.ok || partRes.status === "failed" || partRes.status === "skipped") break;
    }
    result[res.status] += 1;
    await logDelivery({
      report_run_id: reportRunId,
      user_id: userId,
      channel: "telegram",
      recipient: chatId,
      status: res.status,
      error: res.error,
      response_meta: { ...(res.response_meta || {}), dry_run: dryRun || res.status === "dry_run" },
    });
  }

  for (const user of users || []) {
    const pref = prefsByUser.get(user.id);
    const enabled = Boolean(pref?.email_alerts);
    if (!enabled || !isDeliverableEmail(user.email)) {
      if (enabled && user.email) {
        result.skipped += 1;
        await logDelivery({
          report_run_id: reportRunId,
          user_id: user.id,
          channel: "email",
          recipient: user.email,
          status: "skipped",
          error: "Reserved or invalid email recipient",
          response_meta: { dry_run: dryRun },
        });
      }
      continue;
    }
    result.attempted += 1;
    const res = await sendEmail(settings, user.email, subject, html, text);
    result[res.status] += 1;
    await logDelivery({
      report_run_id: reportRunId,
      user_id: user.id,
      channel: "email",
      recipient: user.email,
      status: res.status,
      error: res.error,
      response_meta: { ...(res.response_meta || {}), dry_run: dryRun || res.status === "dry_run" },
    });
  }

  return result;
}
