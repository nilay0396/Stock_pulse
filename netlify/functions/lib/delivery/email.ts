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

function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `Rs ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function pct(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return esc(value);
  return `${n > 0 ? "+" : ""}${n}%`;
}

function range(low: unknown, high: unknown): string {
  const a = money(low);
  const b = money(high);
  return a === "-" && b === "-" ? "-" : `${a} - ${b}`;
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
  return ["NIFTY", "BANKNIFTY", "INDIAVIX"]
    .map((key) => {
      const m = macro[key];
      return m ? `${key} ${m.last ?? "-"} (${pct(m.change_pct)})` : null;
    })
    .filter(Boolean)
    .join(" | ") || "Market snapshot unavailable";
}

function followupReturn(item: any): string {
  if (item.return_range_text) return String(item.return_range_text);
  return pct(item.return_pct);
}

function ideaRows(ideas: any[]): string {
  return ideas.map((idea) => {
    const conviction = idea.effective_conviction ?? idea.horizon_conviction ?? idea.conviction ?? "-";
    const dataScore = Number(idea.data_confidence_score);
    const dataText = Number.isFinite(dataScore)
      ? `Data ${dataScore}/100${idea.data_gaps?.length ? `; missing ${idea.data_gaps.slice(0, 2).join(", ")}` : ""}`
      : "";
    return `
    <tr>
      <td><strong>${esc(idea.symbol)}</strong><br><span>${esc(idea.name || idea.sector || "")}</span></td>
      <td>New ${esc(idea.horizon || "trade")} setup<br><span>${esc(idea.direction || "watch")}</span></td>
      <td>${esc(conviction)}<br><span>R:R ${esc(idea.risk_reward ?? "-")}${idea.fno_score !== undefined ? ` | F&O ${esc(idea.fno_score)}/100` : ""}</span><br><span>${esc(dataText)}</span></td>
      <td>${esc(range(idea.entry_low, idea.entry_high))}</td>
      <td>${esc(money(idea.stop_loss))}</td>
      <td>T1 ${esc(money(idea.target_low))}<br>T2 ${esc(money(idea.target_high))}</td>
      <td>${esc((idea.rationale || "").replace(/\s+/g, " ").slice(0, 260))}</td>
    </tr>
  `;
  }).join("");
}

function activeRows(items: any[]): string {
  return items.map((item) => `
    <tr>
      <td><strong>${esc(item.symbol)}</strong><br><span>${esc(item.name || item.horizon || "")}</span></td>
      <td>HOLD / MANAGE<br><span>${esc(item.days_active ?? 0)}d active</span></td>
      <td>${esc(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}<br><span>${esc(item.entry_date || "")}</span></td>
      <td>${esc(money(item.current_price))}<br><span>${esc(followupReturn(item))}</span></td>
      <td>${esc(money(item.stop_loss))}</td>
      <td>T1 ${esc(money(item.target_low))}<br>T2 ${esc(money(item.target_high))}</td>
      <td>Hold while above stop. Exit if stop hits. Review if fresh earnings/news/corporate-action risk appears.</td>
    </tr>
  `).join("");
}

function trailingRows(items: any[]): string {
  return items.map((item) => `
    <tr>
      <td><strong>${esc(item.symbol)}</strong><br><span>${esc(item.name || item.horizon || "")}</span></td>
      <td>TARGET 1 DONE<br><span>Booked ${esc(item.partial_exit_pct ?? 50)}%</span></td>
      <td>${esc(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}<br><span>${esc(item.entry_date || "")}</span></td>
      <td>${esc(money(item.target1_price || item.target_low))}<br><span>${esc(item.target1_date || "")}</span></td>
      <td>${esc(money(item.current_price))}<br><span>${esc(followupReturn(item))}</span></td>
      <td>${esc(money(item.trailing_stop || item.entry_price || item.entry_low))}</td>
      <td>${esc(money(item.target_high))}</td>
      <td>Trail balance; close if trailing stop breaks or final target hits.</td>
    </tr>
  `).join("");
}

function pendingRows(items: any[]): string {
  return items.map((item) => `
    <tr>
      <td><strong>${esc(item.symbol)}</strong><br><span>${esc(item.name || item.horizon || "")}</span></td>
      <td>WAIT FOR ENTRY<br><span>${esc(item.days_active ?? 0)}d old</span></td>
      <td>${esc(money(item.current_price))}</td>
      <td>${esc(range(item.entry_low, item.entry_high))}</td>
      <td>${esc(money(item.stop_loss))}</td>
      <td>T1 ${esc(money(item.target_low))}<br>T2 ${esc(money(item.target_high))}</td>
      <td>Do not chase. Act only if price enters the zone.</td>
    </tr>
  `).join("");
}

function resolvedRows(items: any[]): string {
  return items.map((item) => `
    <tr>
      <td><strong>${esc(item.symbol)}</strong><br><span>${esc(item.name || item.horizon || "")}</span></td>
      <td>${esc(String(item.status || "").replace(/_/g, " "))}</td>
      <td>${esc(item.entry_price ? money(item.entry_price) : range(item.entry_low, item.entry_high))}</td>
      <td>${esc(money(item.exit_price || item.current_price))}<br><span>${esc(item.exit_date || "")}</span></td>
      <td>${esc(followupReturn(item))}</td>
      <td>${esc(item.ai_followup || item.status_note || "")}</td>
    </tr>
  `).join("");
}

function dataReviewRows(items: any[]): string {
  return items.map((item) => `
    <tr>
      <td><strong>${esc(item.symbol)}</strong><br><span>${esc(item.name || item.horizon || "")}</span></td>
      <td>DO NOT TRADE</td>
      <td>${esc(money(item.current_price))}</td>
      <td>${esc(range(item.entry_low, item.entry_high))}</td>
      <td>Entry zone does not match current price. Needs manual review before any action.</td>
    </tr>
  `).join("");
}

function emptyRow(cols: number, text: string): string {
  return `<tr><td colspan="${cols}" style="color:#9ca3af">${esc(text)}</td></tr>`;
}

function table(title: string, head: string[], body: string): string {
  return `
    <h2 style="font-size:18px;margin:28px 0 8px">${esc(title)}</h2>
    <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;color:#f4f4f5;border-top:1px solid #27272a">
      <thead><tr style="color:#9ca3af;text-align:left">${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

export function renderReportEmail(context: Record<string, any>): string {
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

  return `<!doctype html>
  <html>
    <body style="margin:0;background:#08090b;color:#f4f4f5;font-family:Arial,sans-serif">
      <div style="max-width:980px;margin:0 auto;padding:28px">
        <p style="letter-spacing:3px;color:#9ca3af;font-size:11px;margin:0 0 8px">MARKET PULSE INDIA</p>
        <h1 style="margin:0 0 8px;font-size:30px">Decision Report - ${esc(context.run_date)}</h1>
        <p style="color:#d4d4d8;line-height:1.6">${esc(macroLine(context))}</p>
        <div style="background:#111316;padding:14px 16px;border-radius:6px;margin:18px 0;color:#e5e7eb">
          <strong>Action Summary:</strong>
          New setups ${newIdeas.length} (${weekly.length} weekly, ${monthly.length} monthly) |
          Manage entered ${active.length} |
          Target-1/trailing ${trailing.length} |
          Pending entries ${pending.length} |
          Data review ${dataReview.length} |
          Resolved ${resolved.length}
        </div>
        ${table("1. New Setups Today", ["Symbol", "Action", "Conviction", "Entry", "Stop", "Targets", "Why"], newIdeas.length ? ideaRows(newIdeas) : emptyRow(7, "No new weekly or monthly entries today. Do not force a fresh trade; manage existing plans below."))}
        ${table("2. Manage Entered Positions", ["Symbol", "Action", "Entry", "Current", "Stop", "Targets", "Rule"], active.length ? activeRows(active) : emptyRow(7, "No entered positions need normal hold/stop management."))}
        ${table("3. Target-1 Hit / Trailing Balance", ["Symbol", "Action", "Original Entry", "T1 Hit", "Current", "Trail Stop", "Final Target", "Rule"], trailing.length ? trailingRows(trailing) : emptyRow(8, "No target-1/trailing positions today."))}
        ${table("4. Pending Entry Watchlist", ["Symbol", "Action", "Current", "Entry Zone", "Stop", "Targets", "Rule"], pending.length ? pendingRows(pending) : emptyRow(7, "No pending entries."))}
        ${table("5. Data Review / Not Actionable", ["Symbol", "Action", "Current", "Stored Entry Zone", "Reason"], dataReview.length ? dataReviewRows(dataReview) : emptyRow(5, "No price/entry mismatches detected."))}
        ${table("6. Resolved Since Last Report", ["Symbol", "Outcome", "Entry", "Exit", "Return", "Note"], resolved.length ? resolvedRows(resolved) : emptyRow(6, "No plans resolved since the last report."))}
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:28px">
          Rule: Fresh trades come only from New Setups. Follow-ups are for managing old recommendations, not new entries unless they are in Pending Entry and price enters the zone. Data Review items are not tradeable.
        </p>
      </div>
    </body>
  </html>`;
}

export function renderReportText(context: Record<string, any>): string {
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
  const lines = [
    `Market Pulse India Decision Report - ${context.run_date}`,
    macroLine(context),
    `Summary: new ${newIdeas.length}, manage ${active.length}, trailing ${trailing.length}, pending ${pending.length}, data review ${dataReview.length}, resolved ${resolved.length}`,
    "",
    "1. New Setups Today",
    ...(newIdeas.length ? newIdeas.map((i: any) => `${i.symbol}: entry ${range(i.entry_low, i.entry_high)}, stop ${money(i.stop_loss)}, T1 ${money(i.target_low)}, T2 ${money(i.target_high)}`) : ["No new entries today."]),
    "",
    "2. Manage Entered Positions",
    ...(active.length ? active.map((i: any) => `${i.symbol}: entry ${i.entry_price ? money(i.entry_price) : range(i.entry_low, i.entry_high)}, current ${money(i.current_price)}, stop ${money(i.stop_loss)}, T1 ${money(i.target_low)}, T2 ${money(i.target_high)}`) : ["No entered positions."]),
    "",
    "3. Target-1 Hit / Trailing Balance",
    ...(trailing.length ? trailing.map((i: any) => `${i.symbol}: entry ${i.entry_price ? money(i.entry_price) : range(i.entry_low, i.entry_high)}, booked ${i.partial_exit_pct ?? 50}% at ${money(i.target1_price || i.target_low)}, trail stop ${money(i.trailing_stop || i.entry_price || i.entry_low)}, final target ${money(i.target_high)}`) : ["No trailing positions."]),
    "",
    "4. Pending Entry Watchlist",
    ...(pending.length ? pending.map((i: any) => `${i.symbol}: wait for ${range(i.entry_low, i.entry_high)}, stop ${money(i.stop_loss)}, T1 ${money(i.target_low)}, T2 ${money(i.target_high)}`) : ["No pending entries."]),
    "",
    "5. Data Review / Not Actionable",
    ...(dataReview.length ? dataReview.map((i: any) => `${i.symbol}: DO NOT TRADE; current ${money(i.current_price)} vs stored entry ${range(i.entry_low, i.entry_high)}. Needs manual review.`) : ["No price/entry mismatches detected."]),
    "",
    "6. Resolved Since Last Report",
    ...(resolved.length ? resolved.map((i: any) => `${i.symbol}: ${i.status}, exit ${money(i.exit_price || i.current_price)}, return ${followupReturn(i)}`) : ["No plans resolved since the last report."]),
  ];
  return lines.join("\n");
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
