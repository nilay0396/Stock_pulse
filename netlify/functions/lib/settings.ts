import { db } from "./db.js";

export type SystemSettings = Record<string, unknown>;

export const SETTINGS_DEFAULTS: SystemSettings = {
  telegram_bot_token: "",
  telegram_default_chat_id: "",
  gmail_address: "",
  gmail_app_password: "",
  gmail_from_name: "Market Pulse India",
  fmp_api_key: "",
  fred_api_key: "",
  UPSTOX_ACCESS_TOKEN: "",
  FYERS_CLIENT_ID: "",
  FYERS_ACCESS_TOKEN: "",
  FNO_ENABLE_NSE_DIRECT: "false",
  report_hour: 7,
  report_minute: 0,
  dry_run: true,
};

export const SETTINGS_KEYS = new Set(Object.keys(SETTINGS_DEFAULTS));

function unwrapSettingValue(value: unknown): unknown {
  return value;
}

export async function loadSystemSettings(): Promise<SystemSettings> {
  const { data, error } = await db.from("system_settings").select("key,value");
  if (error) throw new Error(`Failed to load settings: ${error.message}`);

  const settings: SystemSettings = { ...SETTINGS_DEFAULTS };
  for (const row of data || []) {
    settings[row.key] = unwrapSettingValue(row.value);
  }

  settings.telegram_bot_token ||= process.env.TELEGRAM_BOT_TOKEN || "";
  settings.telegram_default_chat_id ||= process.env.TELEGRAM_DEFAULT_CHAT_ID || "";
  settings.gmail_address ||= process.env.GMAIL_ADDRESS || "";
  settings.gmail_app_password ||= process.env.GMAIL_APP_PASSWORD || "";
  settings.gmail_from_name ||= process.env.GMAIL_FROM_NAME || SETTINGS_DEFAULTS.gmail_from_name;
  settings.fmp_api_key ||= process.env.FMP_API_KEY || "";

  return settings;
}

export async function saveSystemSettings(input: SystemSettings): Promise<SystemSettings> {
  const rows = Object.entries(input)
    .filter(([key]) => SETTINGS_KEYS.has(key))
    .map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));

  if (rows.length) {
    const { error } = await db.from("system_settings").upsert(rows, { onConflict: "key" });
    if (error) throw new Error(`Failed to save settings: ${error.message}`);
  }

  return loadSystemSettings();
}

export function asString(settings: SystemSettings, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function asBoolean(settings: SystemSettings, key: string): boolean {
  const value = settings[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return Boolean(value);
}

export function asNumber(settings: SystemSettings, key: string, fallback: number): number {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : fallback;
}
