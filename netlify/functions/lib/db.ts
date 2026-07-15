import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Lazily construct the client on first query rather than at module import
// time. A missing env var thrown at import time crashes the entire bundled
// function before Hono's request handling (and its onError handler) ever
// gets a chance to run, which surfaces to callers as an opaque 502 instead
// of a JSON error. Deferring the throw to first use means it happens inside
// a request, where Hono catches it and returns a clean 500 response.
function getClient(): SupabaseClient {
  if (client) return client;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  // Service-role client — bypasses RLS. Only ever used server-side inside
  // Netlify Functions, never exposed to the frontend.
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// Proxy so existing call sites (`db.from(...)`) don't need to change —
// every property access goes through getClient(), which only throws once
// a route actually tries to use the database. Methods are bound to the
// real client instance (not the proxy) so internal `this` references work
// correctly regardless of how the caller invokes them.
export const db: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const real = getClient();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
