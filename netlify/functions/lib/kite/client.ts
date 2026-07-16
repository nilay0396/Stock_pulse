import { KiteConnect } from "kiteconnect";
import type { Connect } from "kiteconnect";
import { db } from "../db.js";

/** Constructs a KiteConnect client authenticated with the current
 * access_token from system_settings (refreshed daily by
 * kite-token-refresh.ts). Throws a clear error if no token has been set
 * yet, rather than making a request that will 403 with a confusing
 * upstream error.
 *
 * Note: `KiteConnect` (the imported value) is the *constructor* — its
 * type is `{ new(params): Connect }`. Instances are typed `Connect`, not
 * `KiteConnect`. */
export async function getAuthenticatedKiteClient(): Promise<Connect> {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    throw new Error("KITE_API_KEY is not set");
  }

  const { data, error } = await db
    .from("system_settings")
    .select("value")
    .eq("key", "kite_access_token")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Kite access token: ${error.message}`);
  }
  if (!data || !data.value) {
    throw new Error(
      "No Kite access token in system_settings — run kite-token-refresh first",
    );
  }

  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(data.value as string);
  return kc;
}
