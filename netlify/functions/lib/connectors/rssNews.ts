/**
 * Multi-source RSS news connector.
 * Ported 1:1 from backend/connectors/rss_news.py — 5 Indian markets feeds,
 * dependency-free regex RSS parse, SHA-256(normalized-title) dedup, and
 * lightweight sector/macro/company scope classification against the
 * universe. No XML library; the regex parser matches the Python one exactly.
 */
import { createHash } from "node:crypto";

export const RSS_FEEDS: [string, string][] = [
  ["economic_times", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"],
  ["business_standard", "https://www.business-standard.com/rss/markets-106.rss"],
  ["moneycontrol_markets", "https://www.moneycontrol.com/rss/latestnews.xml"],
  ["moneycontrol_business", "https://www.moneycontrol.com/rss/business.xml"],
  ["reuters_business", "https://www.reutersagency.com/feed/?best-sectors=business-finance&post_type=best"],
];

const SECTOR_KEYWORDS: Record<string, string[]> = {
  Banking: ["bank", "nbfc", "loan", "credit", "deposit", "rbi", "npa"],
  IT: ["tcs", "infosys", "wipro", "hcl", "tech mahindra", "it services", "software"],
  Pharma: ["pharma", "drug", "fda", "generic", "healthcare"],
  Auto: ["auto", "car", "vehicle", "ev", "two-wheeler", "truck"],
  FMCG: ["fmcg", "consumer goods", "hul", "itc", "nestle"],
  Metals: ["steel", "copper", "aluminium", "metals", "mining"],
  Energy: ["oil", "crude", "gas", "petroleum", "ongc", "refinery"],
  Infrastructure: ["infra", "cement", "construction", "road", "port"],
  Power: ["power", "electricity", "renewable", "coal"],
  Chemicals: ["chemical", "paint", "specialty"],
  Consumer: ["retail", "fashion", "d2c", "titan", "jubilant"],
  Telecom: ["telecom", "5g", "bharti", "jio", "vodafone"],
};

const MACRO_KEYWORDS = [
  "rbi", "rate cut", "rate hike", "inflation", "cpi", "wpi", "gdp", "budget",
  "fii", "dii", "fiscal deficit", "trade deficit", "monsoon", "fed",
  "interest rate", "bond yield", "rupee",
];

function normTitle(t: string): string {
  return (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashTitle(t: string): string {
  return createHash("sha256").update(normTitle(t), "utf8").digest("hex").slice(0, 12);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RssItem {
  title: string;
  link: string;
  pub_date: string;
  description: string;
  source: string;
  id: string;
  ingested_at: string;
  scope: "company" | "sector" | "macro" | "other";
  matched_symbols: string[];
  matched_sectors: string[];
}

function parseRssEntries(xml: string): { title: string; link: string; pub_date: string; description: string }[] {
  const items: { title: string; link: string; pub_date: string; description: string }[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const tag = (t: string): string => {
      const mm = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(block);
      if (!mm) return "";
      let raw = mm[1].trim();
      raw = raw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
      return raw.replace(/<[^>]+>/g, "").trim();
    };
    const title = tag("title");
    if (!title) continue;
    items.push({
      title,
      link: tag("link"),
      pub_date: tag("pubdate") || tag("dc:date"),
      description: tag("description").slice(0, 400),
    });
  }
  return items;
}

function classify(
  title: string,
  desc: string,
  symbols: Record<string, string>,
): { scope: RssItem["scope"]; matched_symbols: string[]; matched_sectors: string[] } {
  const hay = `${title} ${desc}`.toLowerCase();
  const matchedSyms: string[] = [];
  for (const [sym, name] of Object.entries(symbols)) {
    const nameTokens = (name || "").toLowerCase().split(/\s+/).slice(0, 2);
    const nameProbe = nameTokens.join(" ").trim();
    if (new RegExp(`\\b${escapeRegex(sym.toLowerCase())}\\b`).test(hay)) {
      matchedSyms.push(sym);
    } else if (nameProbe && nameProbe.length > 3 && hay.includes(nameProbe)) {
      matchedSyms.push(sym);
    }
  }
  const matchedSectors = Object.entries(SECTOR_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => hay.includes(k)))
    .map(([s]) => s);
  const isMacro = MACRO_KEYWORDS.some((k) => hay.includes(k));

  let scope: RssItem["scope"];
  if (matchedSyms.length) scope = "company";
  else if (isMacro && matchedSectors.length === 0) scope = "macro";
  else if (matchedSectors.length) scope = "sector";
  else if (isMacro) scope = "macro";
  else scope = "other";

  return { scope, matched_symbols: matchedSyms, matched_sectors: matchedSectors };
}

async function fetchFeed(source: string, url: string): Promise<{ title: string; link: string; pub_date: string; description: string; source: string }[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch(url, { headers: { "User-Agent": "MarketPulse/1.0" }, redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    if (r.status !== 200) {
      console.warn(`rss ${source} HTTP ${r.status}`);
      return [];
    }
    const text = await r.text();
    return parseRssEntries(text).map((e) => ({ ...e, source }));
  } catch (err) {
    console.warn(`rss ${source} failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** Flat list of deduplicated, classified news items across all 5 feeds. */
export async function fetchRssNews(
  universe: { symbol?: string; name?: string }[] = [],
  maxPerFeed = 40,
): Promise<RssItem[]> {
  const symbols: Record<string, string> = {};
  for (const u of universe) {
    if (u.symbol) symbols[u.symbol.toUpperCase()] = u.name || "";
  }

  const feeds = await Promise.all(RSS_FEEDS.map(([s, u]) => fetchFeed(s, u)));

  const seen = new Set<string>();
  const out: RssItem[] = [];
  const now = new Date().toISOString();
  for (const feed of feeds) {
    for (const item of feed.slice(0, maxPerFeed)) {
      const h = hashTitle(item.title);
      if (seen.has(h)) continue;
      seen.add(h);
      const cls = classify(item.title, item.description || "", symbols);
      out.push({ ...item, id: h, ingested_at: now, ...cls });
    }
  }
  return out;
}

/** Group classified items by matched symbol, for per-stock sentiment. */
export function rssBySymbol(items: RssItem[]): Record<string, RssItem[]> {
  const out: Record<string, RssItem[]> = {};
  for (const it of items) {
    for (const sym of it.matched_symbols) {
      (out[sym] ||= []).push(it);
    }
  }
  return out;
}
