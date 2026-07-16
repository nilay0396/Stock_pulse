/**
 * Refreshes the Kite Connect access token (TOTP auto-login) and the
 * NSE-equity + NFO-options instrument-master cache.
 *
 * NOT yet on a cron schedule (no `config.schedule` export) — per the
 * Phase 3a plan, this stays manually-triggerable until a live login has
 * been verified end-to-end. Once confirmed working, add:
 *   export const config = { schedule: "45 0 * * 1-5" };  // 06:15 IST, weekdays
 *
 * Gated by a shared secret (KITE_REFRESH_SECRET) since this triggers a
 * real login against the user's live trading account — not something that
 * should be publicly invokable by anyone who finds the function URL.
 */
import type { Connect } from "kiteconnect";
import { refreshKiteToken } from "./lib/kite/auth.js";
import { getAuthenticatedKiteClient } from "./lib/kite/client.js";
import { db } from "./lib/db.js";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function refreshInstrumentCache(kc: Connect): Promise<{ nse: number; nfo: number }> {
  const [nseInstruments, nfoInstruments] = await Promise.all([
    kc.getInstruments("NSE"),
    kc.getInstruments("NFO"),
  ]);
  const refreshedAt = new Date().toISOString();

  const rows: Record<string, unknown>[] = [];

  let nseCount = 0;
  for (const inst of nseInstruments) {
    if (inst.instrument_type !== "EQ") continue;
    nseCount++;
    rows.push({
      instrument_token: Number(inst.instrument_token),
      tradingsymbol: inst.tradingsymbol,
      name: inst.name || null,
      expiry: null,
      strike: null,
      instrument_type: "EQ",
      segment: inst.segment,
      exchange: inst.exchange,
      refreshed_at: refreshedAt,
    });
  }

  let nfoCount = 0;
  for (const inst of nfoInstruments) {
    if (inst.instrument_type !== "CE" && inst.instrument_type !== "PE") continue;
    nfoCount++;
    const expiryStr = inst.expiry ? toDateOnly(new Date(inst.expiry)) : null;
    rows.push({
      instrument_token: Number(inst.instrument_token),
      tradingsymbol: inst.tradingsymbol,
      name: inst.name || null,
      expiry: expiryStr,
      strike: inst.strike || null,
      instrument_type: inst.instrument_type,
      segment: inst.segment,
      exchange: inst.exchange,
      refreshed_at: refreshedAt,
    });
  }

  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await db.from("kite_instruments").upsert(chunk, { onConflict: "instrument_token" });
    if (error) {
      throw new Error(`Instrument cache upsert failed at offset ${i}: ${error.message}`);
    }
  }

  return { nse: nseCount, nfo: nfoCount };
}

export default async (req: Request): Promise<Response> => {
  const expectedSecret = process.env.KITE_REFRESH_SECRET;
  // If no secret is configured, allow the call through (first-deploy
  // convenience during manual-trigger testing) but warn loudly in logs.
  // Once verified, set KITE_REFRESH_SECRET so this can't be publicly
  // re-triggered by anyone who finds/guesses the function URL — this
  // fires a real login against the user's live trading account.
  //
  // TODO when adding `config.schedule` later: Netlify's own cron trigger
  // won't send this custom header, so this check needs to either accept
  // Netlify's scheduled-invocation signature too, or this function needs
  // splitting into an unauthenticated cron entrypoint that calls the same
  // guarded logic internally. Resolve this before enabling the schedule.
  if (!expectedSecret) {
    console.warn("kite-token-refresh: KITE_REFRESH_SECRET not set — endpoint is unauthenticated");
  } else if (req.headers.get("x-refresh-secret") !== expectedSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    console.log("kite-token-refresh: starting");
    const mode = new URL(req.url).searchParams.get("mode");
    const tokenResult = mode === "instruments" ? null : await refreshKiteToken();

    if (mode !== "instruments") {
      return new Response(
        JSON.stringify({
          ok: true,
          refreshed_at: tokenResult?.refreshedAt ?? null,
          instruments: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const kc = await getAuthenticatedKiteClient();
    const instrumentCounts = await refreshInstrumentCache(kc);
    console.log(
      `kite-token-refresh: instrument cache refreshed (nse=${instrumentCounts.nse} nfo=${instrumentCounts.nfo})`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        refreshed_at: tokenResult?.refreshedAt ?? null,
        instruments: instrumentCounts,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("kite-token-refresh: failed", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
