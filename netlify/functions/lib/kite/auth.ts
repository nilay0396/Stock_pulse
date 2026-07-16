/**
 * Kite Connect TOTP-automated headless login.
 *
 * Ported from the user's working Python reference script (requests +
 * pyotp + kiteconnect). This flow is UNOFFICIAL — Zerodha's docs only
 * cover the browser-redirect login; POST /api/login and /api/twofa are
 * undocumented endpoints reverse-engineered from the browser login page.
 * If Zerodha changes these, this breaks (same risk the reference script
 * already carries).
 *
 * Security note: unlike the reference script, this does NOT log the TOTP
 * code, password, or full tokens anywhere — only high-level step markers.
 * Netlify function logs get pasted into chat/screenshots during debugging,
 * so secrets must never land in them.
 */
import { KiteConnect } from "kiteconnect";
import { CookieJar } from "tough-cookie";
import fetchCookie from "fetch-cookie";
import { TOTP, Secret } from "otpauth";
import { db } from "../db.js";

interface KiteApiResponse {
  status: string;
  message?: string;
  data?: { request_id: string; twofa_type?: string };
}

interface KiteCreds {
  apiKey: string;
  apiSecret: string;
  userId: string;
  password: string;
  totpSecret: string;
}

function requireCreds(): KiteCreds {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  const userId = process.env.ZERODHA_USER_ID;
  const password = process.env.ZERODHA_PASSWORD;
  const totpSecret = process.env.ZERODHA_TOTP_SECRET;
  const missing = Object.entries({
    KITE_API_KEY: apiKey,
    KITE_API_SECRET: apiSecret,
    ZERODHA_USER_ID: userId,
    ZERODHA_PASSWORD: password,
    ZERODHA_TOTP_SECRET: totpSecret,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing Kite env vars: ${missing.join(", ")}`);
  }
  return { apiKey: apiKey!, apiSecret: apiSecret!, userId: userId!, password: password!, totpSecret: totpSecret! };
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "X-Kite-Version": "3",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateTotpCode(totpSecretBase32: string): string {
  const totp = new TOTP({
    secret: Secret.fromBase32(totpSecretBase32),
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });
  return totp.generate();
}

function extractRequestToken(value: string | null | undefined): string | null {
  if (!value || !value.includes("request_token=")) return null;
  try {
    return new URL(value).searchParams.get("request_token");
  } catch {
    const match = value.match(/[?&]request_token=([^&#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function extractQueryParam(value: string | null | undefined, key: string): string | null {
  if (!value || !value.includes(`${key}=`)) return null;
  try {
    return new URL(value).searchParams.get(key);
  } catch {
    const match = value.match(new RegExp(`[?&]${key}=([^&#]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function describeUrl(value: string | null | undefined): string {
  if (!value) return "none";
  try {
    const url = new URL(value);
    const queryKeys = [...url.searchParams.keys()].sort();
    return `${url.host}${url.pathname}${queryKeys.length ? `?keys=${queryKeys.join(",")}` : ""}`;
  } catch {
    return value.includes("request_token=") ? "unparseable-url-with-request-token" : "unparseable-url";
  }
}

function withQueryParam(value: string, key: string, paramValue: string): string {
  const url = new URL(value);
  url.searchParams.set(key, paramValue);
  return url.toString();
}

/** Mirrors the reference script's window-alignment guard: if the current
 * 30s TOTP window is about to expire, wait for a fresh one before
 * generating/posting a code, to avoid a race against expiry. */
async function waitForFreshTotpWindow(): Promise<void> {
  const secsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (secsLeft < 5) {
    await sleep((secsLeft + 1) * 1000);
  }
}

async function getRequestToken(creds: KiteCreds): Promise<string> {
  const jar = new CookieJar();
  const fetchWithCookies = fetchCookie(fetch, jar);
  const connectUrl = `https://kite.trade/connect/login?api_key=${encodeURIComponent(creds.apiKey)}&v=3`;

  // Step 0: warm up the OAuth-flow cookies (which app/redirect_url this
  // session is authorizing).
  await fetchWithCookies(connectUrl, { headers: BROWSER_HEADERS, redirect: "follow" });

  // Step 1: POST credentials.
  const loginRes = await fetchWithCookies("https://kite.zerodha.com/api/login", {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_id: creds.userId, password: creds.password }).toString(),
  });
  const loginBody = (await loginRes.json()) as KiteApiResponse;
  if (loginBody.status !== "success" || !loginBody.data) {
    throw new Error(`Kite login step failed: ${loginBody.message || JSON.stringify(loginBody)}`);
  }
  const requestId: string = loginBody.data.request_id;
  let twofaType: string = loginBody.data.twofa_type || "totp";
  // External TOTP is enabled on this account — always use 'totp', not 'app_code'.
  if (twofaType === "app_code") twofaType = "totp";
  console.log("kite-auth: login step ok");

  // Step 2: POST TOTP — wait for a fresh window to avoid edge expiry.
  await waitForFreshTotpWindow();
  const totpCode = generateTotpCode(creds.totpSecret);
  const twofaRes = await fetchWithCookies("https://kite.zerodha.com/api/twofa", {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_id: creds.userId,
      request_id: requestId,
      twofa_value: totpCode,
      twofa_type: twofaType,
      skip_session: "",
    }).toString(),
  });
  const twofaBody = (await twofaRes.json()) as KiteApiResponse;
  if (twofaBody.status !== "success") {
    throw new Error(`Kite 2FA step failed: ${twofaBody.message || JSON.stringify(twofaBody)}`);
  }
  console.log("kite-auth: 2FA step ok");

  // Step 3: now that the session is authenticated, walk the OAuth
  // connect/login redirect chain manually (redirect: "manual") to capture
  // request_token from a Location header, without actually following the
  // final hop to the app's redirect_url (often an unreachable localhost).
  let url = connectUrl;
  let requestToken: string | null = null;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetchWithCookies(url, { headers: BROWSER_HEADERS, redirect: "manual" });
    const location = res.headers.get("location");
    const candidateUrl = location ? new URL(location, url).toString() : res.url;
    console.log(
      `kite-auth: oauth hop ${hop + 1} status=${res.status} current=${describeUrl(res.url)} location=${describeUrl(candidateUrl)}`,
    );
    requestToken = extractRequestToken(candidateUrl);
    if (requestToken) break;

    const sessId = extractQueryParam(candidateUrl, "sess_id");
    if (sessId) {
      console.log("kite-auth: connect session id obtained; continuing with skip_session");
      url = withQueryParam(candidateUrl, "skip_session", "true");
      continue;
    }

    const text = await res.text();
    requestToken = extractRequestToken(text);
    if (requestToken) break;

    if (!location) break;
    url = candidateUrl;
  }

  if (!requestToken) {
    throw new Error("No request_token found while walking Kite's OAuth redirect chain");
  }
  return requestToken;
}

export interface KiteTokenRefreshResult {
  accessToken: string;
  refreshedAt: string;
}

/** Runs the full login flow and persists the resulting access_token to
 * system_settings. Every Kite-dependent connector reads it from there —
 * no local .env to rewrite, no process to restart (serverless functions
 * read current settings on every invocation). */
export async function refreshKiteToken(): Promise<KiteTokenRefreshResult> {
  const creds = requireCreds();
  console.log("kite-auth: starting login flow");

  const requestToken = await getRequestToken(creds);
  console.log("kite-auth: request_token obtained");

  const kc = new KiteConnect({ api_key: creds.apiKey });
  const session = await kc.generateSession(requestToken, creds.apiSecret);
  console.log("kite-auth: session generated");

  const refreshedAt = new Date().toISOString();
  const { error } = await db.from("system_settings").upsert(
    [
      { key: "kite_access_token", value: session.access_token, updated_at: refreshedAt },
      { key: "kite_access_token_refreshed_at", value: refreshedAt, updated_at: refreshedAt },
    ],
    { onConflict: "key" },
  );
  if (error) {
    throw new Error(`Failed to persist Kite access token: ${error.message}`);
  }

  console.log("kite-auth: token refreshed and persisted");
  return { accessToken: session.access_token, refreshedAt };
}
