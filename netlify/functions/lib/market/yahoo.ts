/**
 * yahoo-finance2 market-data connector.
 * Ported from backend/connectors/market_data.py (MacroConnector +
 * EquityHistoryConnector). yahoo-finance2 v4's `chart()` is one symbol per
 * call (no yfinance-style batch download), so equity OHLC is fetched
 * concurrently with a bounded pool — the JS analog of the Python
 * chunk_size=50 / semaphore(4) pacing.
 */
import YahooFinance from "yahoo-finance2";
import type { OhlcvBar } from "../scoring/indicators.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// Port of MacroConnector.TICKER_MAP (friendly key -> Yahoo symbol).
export const MACRO_TICKER_MAP: Record<string, string> = {
  NIFTY: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  INDIAVIX: "^INDIAVIX",
  SP500: "^GSPC",
  NASDAQ: "^IXIC",
  DOW: "^DJI",
  FTSE: "^FTSE",
  NIKKEI: "^N225",
  HANGSENG: "^HSI",
  DXY: "DX-Y.NYB",
  USDINR: "INR=X",
  CRUDE: "CL=F",
  BRENT: "BZ=F",
  NATGAS: "NG=F",
  GOLD: "GC=F",
  SILVER: "SI=F",
  COPPER: "HG=F",
  US10Y: "^TNX",
  US2Y: "^FVX",
  BTC: "BTC-USD",
};

export interface MacroPoint {
  key: string;
  yf_symbol: string;
  last: number;
  prev: number;
  change: number;
  change_pct: number;
  history: { date: string; close: number }[];
}

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

function isoDaysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

interface ChartQuoteRow {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

async function chartCloses(symbol: string, period1: Date): Promise<ChartQuoteRow[]> {
  // yahoo-finance2's overloaded `chart` resolves to `never` when accessed as
  // an instance method in some TS configs; cast the result to the documented
  // array shape.
  const res = (await yf.chart(symbol, { period1, interval: "1d", return: "array" })) as unknown as {
    quotes: ChartQuoteRow[];
  };
  return res.quotes || [];
}

/** Macro/index snapshot (last/prev/change/change_pct + 60-bar close history)
 * for each requested key. Faithful to MacroConnector.fetch: 3-month window,
 * daily interval, last 60 closes retained. Per-symbol failures are skipped. */
export async function fetchMacro(keys?: string[]): Promise<Record<string, MacroPoint>> {
  const wanted = keys && keys.length ? keys.filter((k) => k in MACRO_TICKER_MAP) : Object.keys(MACRO_TICKER_MAP);
  const period1 = isoDaysAgo(95); // ~3 months
  const out: Record<string, MacroPoint> = {};

  await Promise.all(
    wanted.map(async (key) => {
      const yfSym = MACRO_TICKER_MAP[key];
      try {
        const quotes = (await chartCloses(yfSym, period1)).filter((q) => q.close !== null);
        if (quotes.length === 0) return;
        const last = quotes[quotes.length - 1].close as number;
        const prev = quotes.length > 1 ? (quotes[quotes.length - 2].close as number) : last;
        const change = last - prev;
        const changePct = prev ? ((last - prev) / prev) * 100 : 0;
        out[key] = {
          key,
          yf_symbol: yfSym,
          last: round(last, 4),
          prev: round(prev, 4),
          change: round(change, 4),
          change_pct: round(changePct, 3),
          history: quotes.slice(-60).map((q) => ({
            date: q.date.toISOString().slice(0, 10),
            close: round(q.close as number, 4),
          })),
        };
      } catch (err) {
        console.warn(`yahoo-macro: ${key} (${yfSym}) failed:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  return out;
}

/** Build the Yahoo symbol for an NSE equity from the raw NSE symbol.
 * yahoo-finance2 URL-encodes the path itself, so pass the RAW symbol
 * (e.g. "M&M.NS", not the "%26"-preencoded form the Python yfinance path
 * stored in stock_universe.yf_symbol). */
export function nseYahooSymbol(nseSymbol: string): string {
  return `${nseSymbol.trim().toUpperCase()}.NS`;
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    const i = cursor++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

/**
 * yfinance `.info`-equivalent built from yahoo-finance2 quoteSummary. Only
 * the fields the scoring engine reads are extracted; everything is
 * best-effort (a failed lookup => {} => neutral sub-scores). Concurrent,
 * shortlist-only. yahoo-finance2 v2+ returns bare numbers (not {raw,fmt}).
 */
export async function fetchQuoteSummaryInfo(
  nseSymbols: string[],
  concurrency = 6,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, Record<string, any>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, Record<string, any>> = {};
  await runPool(nseSymbols, concurrency, async (symbol) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qs: any = await yf.quoteSummary(nseYahooSymbol(symbol), {
        modules: ["summaryDetail", "defaultKeyStatistics", "financialData", "price", "assetProfile"],
      });
      const sd = qs.summaryDetail || {};
      const ks = qs.defaultKeyStatistics || {};
      const fd = qs.financialData || {};
      const price = qs.price || {};
      const profile = qs.assetProfile || {};
      out[symbol] = {
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
        website: profile.website ?? null,
        longBusinessSummary: profile.longBusinessSummary ?? null,
        marketCap: price.marketCap ?? sd.marketCap ?? null,
        trailingPE: sd.trailingPE ?? ks.trailingPE ?? null,
        forwardPE: sd.forwardPE ?? null,
        priceToBook: ks.priceToBook ?? null,
        pegRatio: ks.pegRatio ?? null,
        dividendYield: sd.dividendYield ?? null,
        trailingEps: ks.trailingEps ?? null,
        forwardEps: ks.forwardEps ?? null,
        returnOnEquity: fd.returnOnEquity ?? null,
        debtToEquity: fd.debtToEquity ?? null,
        profitMargins: fd.profitMargins ?? ks.profitMargins ?? null,
        operatingMargins: fd.operatingMargins ?? null,
        revenueGrowth: fd.revenueGrowth ?? null,
        earningsGrowth: fd.earningsGrowth ?? ks.earningsQuarterlyGrowth ?? null,
        currentRatio: fd.currentRatio ?? null,
        operatingCashflow: fd.operatingCashflow ?? null,
        targetMeanPrice: fd.targetMeanPrice ?? null,
        currentPrice: fd.currentPrice ?? null,
        freeCashflow: fd.freeCashflow ?? null,
        totalCash: fd.totalCash ?? null,
        totalDebt: fd.totalDebt ?? null,
        grossMargins: fd.grossMargins ?? null,
        ebitdaMargins: fd.ebitdaMargins ?? null,
        fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: sd.fiftyTwoWeekLow ?? null,
        averageVolume: sd.averageVolume ?? null,
        recommendationMean: fd.recommendationMean ?? null,
        numberOfAnalystOpinions: fd.numberOfAnalystOpinions ?? null,
        heldPercentInsiders: ks.heldPercentInsiders ?? null,
        heldPercentInstitutions: ks.heldPercentInstitutions ?? null,
      };
    } catch (err) {
      out[symbol] = {};
      console.warn(`yahoo-info: ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
  });
  return out;
}

export async function fetchYahooSearchNews(query: string, count = 10): Promise<Record<string, any>[]> {
  try {
    const res = (await yf.search(query, { newsCount: count, quotesCount: 0 })) as unknown as Record<string, any>;
    return Array.isArray(res.news) ? res.news.slice(0, count) : [];
  } catch (err) {
    console.warn(`yahoo-news-search: ${query} failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** Concurrent ~1y daily OHLC fetch for a list of NSE symbols, mapped to the
 * OhlcvBar shape computeSnapshot() expects. Keyed by the raw NSE symbol.
 * Per-symbol failures are dropped (fault-isolated), matching the Python
 * connector's chunk-failure tolerance. */
export async function fetchEquityOhlc(
  nseSymbols: string[],
  concurrency = 6,
): Promise<Record<string, OhlcvBar[]>> {
  const period1 = isoDaysAgo(370);
  const out: Record<string, OhlcvBar[]> = {};

  await runPool(nseSymbols, concurrency, async (symbol) => {
    try {
      const quotes = await chartCloses(nseYahooSymbol(symbol), period1);
      const bars: OhlcvBar[] = [];
      for (const q of quotes) {
        if (q.close === null || q.high === null || q.low === null) continue;
        bars.push({ close: q.close, high: q.high, low: q.low, volume: q.volume ?? undefined });
      }
      if (bars.length > 0) out[symbol] = bars;
    } catch (err) {
      console.warn(`yahoo-ohlc: ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
  });
  return out;
}

export interface DatedOhlcvBar extends OhlcvBar {
  date: string;
  open: number | null;
}

export async function fetchEquityOhlcDated(nseSymbol: string, days = 370): Promise<DatedOhlcvBar[]> {
  const quotes = await chartCloses(nseYahooSymbol(nseSymbol), isoDaysAgo(days));
  const bars: DatedOhlcvBar[] = [];
  for (const q of quotes) {
    if (q.close === null || q.high === null || q.low === null) continue;
    bars.push({
      date: q.date.toISOString().slice(0, 10),
      open: q.open ?? null,
      close: q.close,
      high: q.high,
      low: q.low,
      volume: q.volume ?? undefined,
    });
  }
  return bars;
}
