/**
 * Financial Modeling Prep fundamentals connector.
 * Ported from backend/connectors/fmp.py. Optional — the API key lives in
 * system_settings.fmp_api_key (falling back to the FMP_API_KEY env var for
 * the GitHub Actions runner). No key => no-op, and the scoring engine
 * degrades those sub-scores to neutral 50. Capped at 30 symbols/run to
 * respect the free tier (250 req/day; 3 calls/symbol).
 */
import { db } from "../db.js";

const BASE = "https://financialmodelingprep.com/api/v3";

export interface FmpFundamental {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ratios_ttm: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metrics_ttm: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  estimates: any[];
}

async function getJson(path: string, apiKey: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const r = await fetch(`${BASE}/${path.replace(/^\//, "")}?${qs}`, { signal: controller.signal });
  clearTimeout(timer);
  if (r.status !== 200) {
    const body = (await r.text()).slice(0, 120);
    throw new Error(`FMP ${path} HTTP ${r.status}: ${body}`);
  }
  return r.json();
}

async function resolveApiKey(): Promise<string> {
  const { data } = await db.from("system_settings").select("value").eq("key", "fmp_api_key").maybeSingle();
  if (data?.value) return String(data.value);
  return process.env.FMP_API_KEY || "";
}

/** Fetch ratios-ttm / key-metrics-ttm / analyst-estimates per symbol (capped
 * at 30). Returns {} when no key is configured. Per-symbol failures are
 * skipped (fault-isolated), matching the Python connector. */
export async function fetchFmpFundamentals(symbols: string[]): Promise<Record<string, FmpFundamental>> {
  const apiKey = await resolveApiKey();
  if (!apiKey) return {};

  const out: Record<string, FmpFundamental> = {};
  for (const sym of symbols.slice(0, 30)) {
    const ticker = `${sym}.NS`;
    try {
      const ratios = await getJson(`ratios-ttm/${ticker}`, apiKey);
      const metrics = await getJson(`key-metrics-ttm/${ticker}`, apiKey);
      const est = await getJson(`analyst-estimates/${ticker}`, apiKey, { limit: "4" });
      out[sym] = {
        ratios_ttm: Array.isArray(ratios) ? ratios[0] || {} : (ratios as Record<string, unknown>) || {},
        metrics_ttm: Array.isArray(metrics) ? metrics[0] || {} : (metrics as Record<string, unknown>) || {},
        estimates: Array.isArray(est) ? est : [],
      };
    } catch (err) {
      console.warn(`fmp ${sym} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
