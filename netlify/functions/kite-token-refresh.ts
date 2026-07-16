/**
 * Refreshes the Kite Connect access token (TOTP auto-login).
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
import { refreshKiteToken } from "./lib/kite/auth.js";

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
    const tokenResult = await refreshKiteToken();

    return new Response(
      JSON.stringify({
        ok: true,
        refreshed_at: tokenResult.refreshedAt,
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
