/**
 * Official NSE/BSE ingestion runner.
 *
 * Intended to run from a residential/home machine via Windows Task Scheduler,
 * because NSE/BSE frequently block data-centre IPs. Uses Supabase service-role
 * env vars and upserts into the Phase 2 official-data tables.
 */
import { db } from "../lib/db.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

const NSE_BASE = "https://www.nseindia.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function ddmmyyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400000);
}

function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(text: string): Dict[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = csvSplit(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = csvSplit(line);
    const row: Dict = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
}

class NseClient {
  private cookie = "";

  private async refreshCookie(): Promise<void> {
    const res = await fetch(NSE_BASE, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
    });
    const setCookie = res.headers.get("set-cookie") || "";
    this.cookie = setCookie.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  }

  async getJson(path: string): Promise<Dict[]> {
    if (!this.cookie) await this.refreshCookie();
    const res = await fetch(`${NSE_BASE}${path}`, {
      headers: {
        "user-agent": UA,
        accept: "application/json,text/plain,*/*",
        referer: NSE_BASE,
        cookie: this.cookie,
      },
    });
    if (res.status === 401 || res.status === 403) {
      await this.refreshCookie();
      return this.getJson(path);
    }
    if (!res.ok) throw new Error(`NSE ${path} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const body = await res.json() as Dict;
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.data)) return body.data;
    return [];
  }

  async getText(path: string): Promise<string> {
    if (!this.cookie) await this.refreshCookie();
    const res = await fetch(`${NSE_BASE}${path}`, {
      headers: { "user-agent": UA, accept: "text/csv,text/plain,*/*", referer: NSE_BASE, cookie: this.cookie },
    });
    if (!res.ok) throw new Error(`NSE ${path} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    return res.text();
  }
}

function first(row: Dict, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return "";
}

function asNum(value: unknown): number | null {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function replaceUpcomingResults(rows: Dict[]): Promise<number> {
  const mapped = rows.map((r) => ({
    symbol: first(r, ["symbol", "SYMBOL", "Symbol"]),
    company: first(r, ["companyName", "company", "Company Name", "name"]),
    bm_date: first(r, ["bm_date", "meetingDate", "boardMeetingDate", "date", "Board Meeting Date"]),
    bm_date_raw: first(r, ["bm_date", "meetingDate", "boardMeetingDate", "date", "Board Meeting Date"]),
    purpose: first(r, ["purpose", "Purpose"]),
    bm_desc: first(r, ["bm_desc", "desc", "description", "Details"]),
    period: "Upcoming",
    as_of: new Date().toISOString(),
  })).filter((r) => r.symbol && r.bm_date);
  if (!mapped.length) return 0;
  await db.from("financial_results").delete().eq("period", "Upcoming");
  const { error } = await db.from("financial_results").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function upsertAnnouncements(rows: Dict[]): Promise<number> {
  const mapped = rows.map((r) => ({
    symbol: first(r, ["symbol", "SYMBOL", "Symbol"]),
    description: first(r, ["desc", "description", "announcement", "sm_name"]),
    subject: first(r, ["subject", "attchmntText", "headline"]),
    attachment: first(r, ["attchmntFile", "attachment", "url"]),
    disclosure_time: first(r, ["an_dt", "disseminationTime", "disclosureTime"]) || null,
    time_diff: first(r, ["timeDiff", "time_diff"]),
    ingested_at: new Date().toISOString(),
  })).filter((r) => r.symbol && (r.subject || r.description));
  if (!mapped.length) return 0;
  const { error } = await db.from("corp_announcements").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function upsertActions(rows: Dict[]): Promise<number> {
  const mapped = rows.map((r) => ({
    symbol: first(r, ["symbol", "SYMBOL", "Symbol"]),
    series: first(r, ["series", "Series"]),
    subject: first(r, ["subject", "purpose", "Purpose"]),
    ex_date: first(r, ["exDate", "ex_date", "Ex Date"]),
    record_date: first(r, ["recordDate", "record_date", "Record Date"]),
    bc_start: first(r, ["bcStartDate", "bc_start"]),
    bc_end: first(r, ["bcEndDate", "bc_end"]),
    face_value: asNum(first(r, ["faceValue", "face_value"])),
    industry: first(r, ["industry", "Industry"]),
    ingested_at: new Date().toISOString(),
  })).filter((r) => r.symbol && (r.ex_date || r.subject));
  if (!mapped.length) return 0;
  const { error } = await db.from("corp_actions").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function upsertInsider(rows: Dict[]): Promise<number> {
  const mapped = rows.map((r) => ({
    symbol: first(r, ["symbol", "SYMBOL", "Symbol"]),
    company: first(r, ["company", "companyName", "Company"]),
    acquirer: first(r, ["acquirer", "personName", "Name"]),
    category: first(r, ["category", "personCategory"]),
    tx_type: first(r, ["transactionType", "acqMode", "mode"]),
    shares: asNum(first(r, ["securities", "shares", "noOfShares"])),
    value: asNum(first(r, ["value", "secVal", "totalValue"])),
    tx_date_from: first(r, ["transactionDate", "fromDate"]),
    disclosure_date: first(r, ["disclosureDate", "date"]),
    broadcast_date: first(r, ["broadcastDate"]),
    raw: r,
    ingested_at: new Date().toISOString(),
  })).filter((r) => r.symbol);
  if (!mapped.length) return 0;
  const { error } = await db.from("insider_trades").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function upsertShareholding(rows: Dict[]): Promise<number> {
  const mapped = rows.map((r) => ({
    symbol: first(r, ["symbol", "SYMBOL", "Symbol"]),
    name: first(r, ["companyName", "company", "Company"]),
    date: first(r, ["date", "submissionDate", "quarterEnded"]),
    xbrl: first(r, ["xbrl", "xbrlLink"]),
    pdf: first(r, ["pdf", "attachment"]),
    description: first(r, ["description", "desc"]),
    ingested_at: new Date().toISOString(),
  })).filter((r) => r.symbol);
  if (!mapped.length) return 0;
  const { error } = await db.from("shareholding_filings").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function ingestNseBhavDelivery(client: NseClient): Promise<number> {
  const date = daysAgo(1);
  const path = `/api/historical/securityArchives?from=${ddmmyyyy(date)}&to=${ddmmyyyy(date)}&segmentLink=3&symbol=all&dataType=priceVolumeDeliverable&series=EQ`;
  const rows = await client.getJson(path);
  const mapped = rows.map((r) => ({
    symbol: first(r, ["CH_SYMBOL", "symbol", "SYMBOL"]),
    date: first(r, ["CH_TIMESTAMP", "date"]),
    prev_close: asNum(first(r, ["CH_PREVIOUS_CLS_PRICE", "prev_close"])),
    open: asNum(first(r, ["CH_OPENING_PRICE", "open"])),
    high: asNum(first(r, ["CH_TRADE_HIGH_PRICE", "high"])),
    low: asNum(first(r, ["CH_TRADE_LOW_PRICE", "low"])),
    close: asNum(first(r, ["CH_CLOSING_PRICE", "close"])),
    traded_qty: asNum(first(r, ["CH_TOT_TRADED_QTY", "traded_qty"])),
    turnover_lacs: asNum(first(r, ["CH_TOT_TRADED_VAL", "turnover"])) !== null ? Number(asNum(first(r, ["CH_TOT_TRADED_VAL", "turnover"]))) / 100000 : null,
    deliv_qty: asNum(first(r, ["COP_DELIV_QTY", "deliv_qty"])),
    deliv_pct: asNum(first(r, ["COP_DELIV_PERC", "deliv_pct"])),
    as_of: yyyymmdd(date),
    ingested_at: new Date().toISOString(),
  })).filter((r) => r.symbol);
  if (!mapped.length) return 0;
  const { error } = await db.from("bhavcopy_rows").insert(mapped);
  if (error) throw error;
  return mapped.length;
}

async function tryStep(name: string, fn: () => Promise<number>): Promise<{ name: string; count: number; error?: string }> {
  try {
    const count = await fn();
    console.log(`official-ingest: ${name} inserted=${count}`);
    return { name, count };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`official-ingest: ${name} failed: ${error}`);
    return { name, count: 0, error };
  }
}

async function main(): Promise<void> {
  const days = Math.max(1, Number(process.env.OFFICIAL_INGEST_DAYS || "7"));
  const client = new NseClient();
  const from = ddmmyyyy(daysAgo(days));
  const to = ddmmyyyy(new Date());

  const summary = await Promise.all([
    tryStep("nse_bhav_delivery", () => ingestNseBhavDelivery(client)),
    tryStep("nse_announcements", async () => upsertAnnouncements(await client.getJson(`/api/corporate-announcements?index=equities&from_date=${from}&to_date=${to}`))),
    tryStep("nse_corporate_actions", async () => upsertActions(await client.getJson(`/api/corporates-corporateActions?index=equities&from_date=${from}&to_date=${to}`))),
    tryStep("nse_board_meetings", async () => replaceUpcomingResults(await client.getJson(`/api/corporate-board-meetings?index=equities&from_date=${from}&to_date=${to}`))),
    tryStep("nse_insider", async () => upsertInsider(await client.getJson(`/api/corporates-pit?index=equities&from_date=${from}&to_date=${to}`))),
    tryStep("nse_shareholding", async () => upsertShareholding(await client.getJson(`/api/corporate-share-holdings-master?index=equities&from_date=${from}&to_date=${to}`))),
  ]);

  console.log("official-ingest result:", JSON.stringify(summary));
}

main().catch((err) => {
  console.error("official-ingest fatal:", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

