import { getAuthenticatedKiteClient } from "./lib/kite/client.js";
import { refreshKiteInstrumentSlice, type KiteInstrumentExchange } from "./lib/kite/instruments.js";

function parseExchange(value: string | null): KiteInstrumentExchange {
  return value === "NFO" ? "NFO" : "NSE";
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default async (req: Request): Promise<Response> => {
  const expectedSecret = process.env.KITE_REFRESH_SECRET;
  if (!expectedSecret) {
    console.warn("kite-instruments-refresh: KITE_REFRESH_SECRET not set - endpoint is unauthenticated");
  } else if (req.headers.get("x-refresh-secret") !== expectedSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const exchange = parseExchange(url.searchParams.get("exchange"));
    const offset = parseOptionalInt(url.searchParams.get("offset"));
    const limit = parseOptionalInt(url.searchParams.get("limit")) ?? 1000;

    console.log(`kite-instruments-refresh: starting exchange=${exchange} offset=${offset ?? 0} limit=${limit}`);
    const kc = await getAuthenticatedKiteClient();
    const result = await refreshKiteInstrumentSlice(kc, { exchange, offset, limit });
    console.log(
      `kite-instruments-refresh: upserted=${result.upserted} total=${result.total_filtered} has_more=${result.has_more}`,
    );

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("kite-instruments-refresh: failed", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
