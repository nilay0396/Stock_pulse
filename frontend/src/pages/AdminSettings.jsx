import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Send, Save, Mail, Zap, Search, Copy, CheckCircle2 } from "lucide-react";
import api from "../lib/api";
import { fmtDate } from "../lib/fmt";

export default function AdminSettings() {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testChat, setTestChat] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [sched, setSched] = useState(null);
  const [discovered, setDiscovered] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [botInfo, setBotInfo] = useState(null);
  const [universeStats, setUniverseStats] = useState(null);
  const [reseedingUniverse, setReseedingUniverse] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = async () => {
    setLoadError("");
    try {
      const [a, sc, u] = await Promise.all([
        api.get("/admin/settings"),
        api.get("/admin/scheduler"),
        api.get("/stocks/universe/stats").catch(() => ({ data: { total: 0, curated: 0, other: 0 } })),
      ]);
      setS(a.data); setSched(sc.data); setUniverseStats(u.data);
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Failed to load settings";
      setLoadError(detail);
      toast.error(detail);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try { const { data } = await api.put("/admin/settings", s); setS(data); toast.success("Settings saved"); await load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
    finally { setSaving(false); }
  };

  const testTg = async () => {
    try { const { data } = await api.post("/admin/test/telegram", { chat_id: testChat }); toast[data.ok ? "success" : "error"](`Telegram → ${data.status}${data.error ? ": " + data.error : ""}`); }
    catch (e) { toast.error(e?.response?.data?.detail || "Test failed"); }
  };
  const testEm = async () => {
    try { const { data } = await api.post("/admin/test/email", { to: testEmail }); toast[data.ok ? "success" : "error"](`Email → ${data.status}${data.error ? ": " + data.error : ""}`); }
    catch (e) { toast.error(e?.response?.data?.detail || "Test failed"); }
  };
  const runReport = async () => {
    try { await api.post("/reports/run"); toast.success("Report generation started (~60–120s)"); }
    catch (e) { toast.error(e?.response?.data?.detail || "Trigger failed"); }
  };

  const reseedFullUniverse = async () => {
    setReseedingUniverse(true);
    try {
      const { data } = await api.post("/admin/seed-full-universe");
      toast.success(`Universe refreshed — fetched ${data.fetched}, inserted ${data.inserted}, total ${data.total}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Refresh failed (NSE may be rate-limited — try again in a few minutes)");
    } finally {
      setReseedingUniverse(false);
    }
  };

  const verifyBot = async () => {
    try {
      const { data } = await api.post("/admin/telegram/get-bot-info");
      setBotInfo(data);
      toast.success(`Bot verified: @${data.username}`);
    } catch (e) { toast.error(e?.response?.data?.detail || "Bot verification failed"); }
  };

  const discoverChats = async () => {
    setDiscovering(true);
    try {
      const { data } = await api.get("/admin/telegram/discover");
      setDiscovered(data);
      if (data.count === 0) {
        toast.message("No chats yet. Ask users to open @" + (botInfo?.username || "your_bot") + " and send /start.");
      } else {
        toast.success(`Found ${data.count} chat${data.count > 1 ? "s" : ""}.`);
      }
    } catch (e) { toast.error(e?.response?.data?.detail || "Discovery failed"); }
    finally { setDiscovering(false); }
  };

  const copyChat = (id) => {
    navigator.clipboard.writeText(String(id));
    toast.success(`Chat ID ${id} copied`);
  };

  if (!s && loadError) return (
    <div className="p-8 flex flex-col gap-3">
      <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>Settings could not load.</div>
      <div className="panel p-4 max-w-2xl">
        <div className="overline">Admin API Error</div>
        <div className="font-body text-[13px] mt-2" style={{ color: "var(--bearish)" }}>{loadError}</div>
        <button className="btn btn-outline mt-4" onClick={load}>Retry</button>
      </div>
    </div>
  );

  const bindAsDefault = async (id) => {
    const next = { ...s, telegram_default_chat_id: String(id) };
    setS(next);
    try {
      await api.put("/admin/settings", { telegram_default_chat_id: String(id) });
      toast.success("Bound as default chat");
      await load();
    } catch (e) { toast.error("Save failed"); }
  };

  const bindToMyPrefs = async (id) => {
    try {
      await api.put("/preferences", { telegram_chat_id: String(id), telegram_alerts: true });
      toast.success("Added to your preferences — you'll get the morning ping");
    } catch (e) { toast.error("Save failed"); }
  };

  if (!s) return <div className="p-8 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</div>;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5 max-w-4xl">
      <header>
        <div className="overline">Admin</div>
        <h1 className="font-heading text-3xl">System Settings</h1>
        <div className="text-[12px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
          Scheduler: {sched ? `${String(sched.report_hour).padStart(2,"0")}:${String(sched.report_minute).padStart(2,"0")} IST` : "—"} · Next run: {fmtDate(sched?.next_run)}
        </div>
      </header>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-telegram">
        <div className="overline">Telegram Bot</div>
        <label className="flex flex-col gap-1.5"><span className="overline">Bot Token</span>
          <input className="input" placeholder="123456:ABC-DEF…" value={s.telegram_bot_token || ""}
                 onChange={(e) => setS({ ...s, telegram_bot_token: e.target.value })} data-testid="settings-tg-token" />
        </label>
        <label className="flex flex-col gap-1.5"><span className="overline">Default Chat ID (fallback)</span>
          <input className="input" value={s.telegram_default_chat_id || ""}
                 onChange={(e) => setS({ ...s, telegram_default_chat_id: e.target.value })} data-testid="settings-tg-default-chat" />
        </label>
        <div className="flex gap-2 items-end">
          <label className="flex flex-col gap-1.5 flex-1"><span className="overline">Test chat ID</span>
            <input className="input" value={testChat} onChange={(e) => setTestChat(e.target.value)} data-testid="settings-tg-test-chat" />
          </label>
          <button className="btn btn-outline" onClick={testTg} data-testid="settings-tg-test-btn"><Send size={14} /> Test send</button>
          <button className="btn btn-outline" onClick={verifyBot} data-testid="settings-tg-verify-btn"><CheckCircle2 size={14} /> Verify bot</button>
        </div>
        {botInfo && (
          <div className="text-[12px] font-mono" style={{ color: "var(--text-muted)" }} data-testid="settings-tg-bot-info">
            Bot: <span style={{ color: "var(--bullish)" }}>@{botInfo.username}</span> ({botInfo.first_name}, id {botInfo.id})
          </div>
        )}

        <div className="panel-elevated p-4 mt-2" data-testid="tg-discover-section">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="overline">Discover chat IDs</div>
              <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>
                Ask each subscriber to open the bot and send <span className="font-mono">/start</span>. Then click Discover.
              </div>
            </div>
            <button className="btn btn-primary" onClick={discoverChats} disabled={discovering} data-testid="settings-tg-discover-btn">
              <Search size={14} /> {discovering ? "Polling…" : "Discover now"}
            </button>
          </div>
          {discovered && (
            <div className="mt-3">
              {discovered.count === 0 ? (
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  No chats found. Once users send <span className="font-mono">/start</span> to the bot, they'll appear here.
                  (Telegram retains updates for only ~24h; run discovery soon after they start.)
                </div>
              ) : (
                <table className="w-full data-table">
                  <thead><tr><th>Chat ID</th><th>Name</th><th>Username</th><th>Type</th><th>Last msg</th><th></th></tr></thead>
                  <tbody>
                    {discovered.chats.map((c) => (
                      <tr key={c.chat_id} data-testid={`tg-chat-${c.chat_id}`}>
                        <td className="font-bold">{c.chat_id}</td>
                        <td className="font-body text-[12px]">{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || "—"}</td>
                        <td className="font-body text-[12px]">{c.username ? `@${c.username}` : "—"}</td>
                        <td className="font-body text-[12px]">{c.type}</td>
                        <td className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{(c.last_text || "").slice(0, 40)}</td>
                        <td>
                          <div className="flex gap-1">
                            <button className="btn btn-ghost" onClick={() => copyChat(c.chat_id)} data-testid={`tg-copy-${c.chat_id}`}><Copy size={12} /> Copy</button>
                            <button className="btn btn-ghost" onClick={() => bindToMyPrefs(c.chat_id)} data-testid={`tg-bind-me-${c.chat_id}`}>Bind to me</button>
                            <button className="btn btn-ghost" onClick={() => bindAsDefault(c.chat_id)} data-testid={`tg-bind-default-${c.chat_id}`}>Default</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-email">
        <div className="overline">Gmail SMTP</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5"><span className="overline">Sender email</span>
            <input className="input" placeholder="you@gmail.com" value={s.gmail_address || ""}
                   onChange={(e) => setS({ ...s, gmail_address: e.target.value })} data-testid="settings-gm-address" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">Gmail App Password</span>
            <input className="input" type="password" placeholder="16-char app password" value={s.gmail_app_password || ""}
                   onChange={(e) => setS({ ...s, gmail_app_password: e.target.value })} data-testid="settings-gm-app-password" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">From name</span>
            <input className="input" value={s.gmail_from_name || ""} onChange={(e) => setS({ ...s, gmail_from_name: e.target.value })} data-testid="settings-gm-from-name" />
          </label>
        </div>
        <div className="flex gap-2 items-end">
          <label className="flex flex-col gap-1.5 flex-1"><span className="overline">Test recipient</span>
            <input className="input" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} data-testid="settings-gm-test-to" />
          </label>
          <button className="btn btn-outline" onClick={testEm} data-testid="settings-gm-test-btn"><Mail size={14} /> Test send</button>
        </div>
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-data-keys">
        <div className="overline">Data-Provider Keys (optional · secondary sources)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5"><span className="overline">Financial Modeling Prep API Key</span>
            <input className="input" type="password" placeholder="free tier: 250 req/day at financialmodelingprep.com" value={s.fmp_api_key || ""}
                   onChange={(e) => setS({ ...s, fmp_api_key: e.target.value })} data-testid="settings-fmp-key" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">FRED (St. Louis Fed) API Key</span>
            <input className="input" type="password" placeholder="free at fred.stlouisfed.org" value={s.fred_api_key || ""}
                   onChange={(e) => setS({ ...s, fred_api_key: e.target.value })} data-testid="settings-fred-key" />
          </label>
        </div>
        <div className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
          Both are optional. When empty, these connectors are gracefully skipped and the report still runs on NSE + yfinance + GDELT.
        </div>
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-fno">
        <div className="overline">F&amp;O Provider Credentials (optional)</div>
        <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          F&amp;O data needs a broker token — NSE's WAF blocks cloud IPs and yfinance
          doesn't carry Indian option chains. Any one of the providers below is enough.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5"><span className="overline">Upstox access token (preferred)</span>
            <input className="input" type="password" placeholder="get from api.upstox.com/v2/login" value={s.UPSTOX_ACCESS_TOKEN || ""}
                   onChange={(e) => setS({ ...s, UPSTOX_ACCESS_TOKEN: e.target.value })} data-testid="settings-upstox-token" />
          </label>
          <div />
          <label className="flex flex-col gap-1.5"><span className="overline">Fyers client ID</span>
            <input className="input" placeholder="XXX-100" value={s.FYERS_CLIENT_ID || ""}
                   onChange={(e) => setS({ ...s, FYERS_CLIENT_ID: e.target.value })} data-testid="settings-fyers-id" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">Fyers access token</span>
            <input className="input" type="password" value={s.FYERS_ACCESS_TOKEN || ""}
                   onChange={(e) => setS({ ...s, FYERS_ACCESS_TOKEN: e.target.value })} data-testid="settings-fyers-token" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox"
                 checked={(s.FNO_ENABLE_NSE_DIRECT || "false").toLowerCase() === "true"}
                 onChange={(e) => setS({ ...s, FNO_ENABLE_NSE_DIRECT: e.target.checked ? "true" : "false" })}
                 data-testid="settings-nse-direct-toggle" />
          <span>Enable NSE direct (only useful behind a residential-IP proxy — WAF blocks data-centre IPs)</span>
        </label>
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-universe">
        <div className="overline">NSE Universe</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="panel-elevated p-3" data-testid="universe-total">
            <div className="overline">Total stocks</div>
            <div className="font-mono text-[22px] mt-1">{universeStats?.total ?? "—"}</div>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              EQ-series + curated
            </div>
          </div>
          <div className="panel-elevated p-3">
            <div className="overline">Curated (with sector)</div>
            <div className="font-mono text-[22px] mt-1">{universeStats?.curated ?? "—"}</div>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Hand-mapped sectors
            </div>
          </div>
          <div className="panel-elevated p-3">
            <div className="overline">Newly seeded</div>
            <div className="font-mono text-[22px] mt-1">{universeStats?.other ?? "—"}</div>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Pulled from EQUITY_L
            </div>
          </div>
          <div className="panel-elevated p-3">
            <div className="overline">ETFs</div>
            <div className="font-mono text-[22px] mt-1">0</div>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Not yet ingested (P1)
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="btn btn-outline"
            onClick={reseedFullUniverse}
            disabled={reseedingUniverse}
            data-testid="reseed-full-universe-btn"
          >
            <Search size={14} /> {reseedingUniverse ? "Refreshing…" : "Refresh Full NSE Universe"}
          </button>
          <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
            Pulls EQUITY_L.csv from nsearchives.nseindia.com — preserves curated sector tags.
          </span>
        </div>
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="settings-schedule">
        <div className="overline">Schedule</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <label className="flex flex-col gap-1.5"><span className="overline">Hour (IST)</span>
            <input className="input" type="number" min="0" max="23" value={s.report_hour ?? 7}
                   onChange={(e) => setS({ ...s, report_hour: Number(e.target.value) })} data-testid="settings-hour" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">Minute</span>
            <input className="input" type="number" min="0" max="59" value={s.report_minute ?? 0}
                   onChange={(e) => setS({ ...s, report_minute: Number(e.target.value) })} data-testid="settings-minute" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!s.dry_run} onChange={(e) => setS({ ...s, dry_run: e.target.checked })} data-testid="settings-dry-run" />
            <span className="text-[13px]">Dry-run (no external sends)</span>
          </label>
        </div>
      </section>

      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={save} disabled={saving} data-testid="save-settings-btn">
          <Save size={14} /> {saving ? "Saving…" : "Save settings"}
        </button>
        <button className="btn btn-outline" onClick={runReport} data-testid="trigger-report-btn"><Zap size={14} /> Trigger report now</button>
      </div>
    </div>
  );
}
