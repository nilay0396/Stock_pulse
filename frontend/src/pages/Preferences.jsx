import { useState } from "react";
import { toast } from "sonner";
import api from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCached, set as cacheSet } from "../lib/cache";
import { ShimmerLine } from "../components/SkeletonBits";

const SECTORS = [
  "Banking","Financial Services","IT","Energy","Auto","FMCG","Consumer","Pharma","Healthcare",
  "Metals","Cement","Infrastructure","Telecom","Power","Chemicals",
];

export default function Preferences() {
  const { user } = useAuth();
  const { data: prefsFromApi, loading } = useCached("prefs:me",
    () => api.get("/preferences").then((r) => r.data));
  // Local edit buffer — defaults let the form render before the fetch returns.
  const [override, setOverride] = useState(null);
  const prefs = override || prefsFromApi || {};
  const setPrefs = (next) => setOverride(typeof next === "function" ? next(prefs) : next);

  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const [pwSaving, setPwSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put("/preferences", prefs);
      cacheSet("prefs:me", data);
      toast.success("Preferences saved");
    } catch (e) { toast.error(e?.response?.data?.detail || "Save failed"); }
    finally { setSaving(false); }
  };

  const changePw = async () => {
    // Client-side validation — matches backend Pydantic `min_length=6`.
    if (!pw.current_password || !pw.new_password) {
      toast.error("Fill both current and new password.");
      return;
    }
    if (pw.new_password.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }
    if (pw.new_password === pw.current_password) {
      toast.error("New password must differ from the current one.");
      return;
    }
    setPwSaving(true);
    try {
      await api.post("/auth/change-password", pw);
      toast.success("Password changed");
      setPw({ current_password: "", new_password: "" });
    } catch (e) {
      // 422 from FastAPI returns a validation array; surface it cleanly
      const detail = e?.response?.data?.detail;
      const msg = Array.isArray(detail)
        ? detail.map((d) => d.msg || "Invalid input").join("; ")
        : (typeof detail === "string" ? detail : "Change failed");
      toast.error(msg);
    }
    finally { setPwSaving(false); }
  };

  const toggleSector = (s) => {
    const list = prefs.preferred_sectors || [];
    const next = list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
    setPrefs({ ...prefs, preferred_sectors: next });
  };

  const showSkeletons = loading && !prefsFromApi;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5 max-w-4xl">
      <header>
        <div className="overline">Account</div>
        <h1 className="font-heading text-3xl">Preferences</h1>
        <div className="text-[12px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>Signed in as {user?.email}</div>
      </header>

      <section className="panel p-5 flex flex-col gap-4" data-testid="prefs-delivery">
        <div className="overline">Delivery</div>
        {showSkeletons ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ShimmerLine h={40} /><ShimmerLine h={40} /><ShimmerLine h={20} /><ShimmerLine h={20} />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5"><span className="overline">Telegram Chat ID</span>
              <input className="input" placeholder="e.g. 123456789" value={prefs.telegram_chat_id || ""}
                     onChange={(e) => setPrefs({ ...prefs, telegram_chat_id: e.target.value })} data-testid="prefs-telegram-chatid" />
            </label>
            <label className="flex flex-col gap-1.5"><span className="overline">Delivery time (IST, fixed at 07:00)</span>
              <input className="input" value="07:00" disabled />
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={!!prefs.telegram_alerts} onChange={(e) => setPrefs({ ...prefs, telegram_alerts: e.target.checked })} data-testid="prefs-telegram-toggle" />
              Send Telegram alert
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={!!prefs.email_alerts} onChange={(e) => setPrefs({ ...prefs, email_alerts: e.target.checked })} data-testid="prefs-email-toggle" />
              Send email report
            </label>
          </div>
        )}
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="prefs-investing">
        <div className="overline">Investing Profile</div>
        {showSkeletons ? (
          <div className="flex flex-col gap-3"><ShimmerLine h={40} /><ShimmerLine h={40} /><ShimmerLine h={80} /></div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1.5"><span className="overline">Horizon</span>
                <select className="input" value={prefs.horizon || "both"} onChange={(e) => setPrefs({ ...prefs, horizon: e.target.value })} data-testid="prefs-horizon">
                  <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="both">Both</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5"><span className="overline">Risk Appetite</span>
                <select className="input" value={prefs.risk_appetite || "medium"} onChange={(e) => setPrefs({ ...prefs, risk_appetite: e.target.value })} data-testid="prefs-risk">
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5"><span className="overline">Language</span>
                <select className="input" value={prefs.language || "en"} onChange={(e) => setPrefs({ ...prefs, language: e.target.value })} data-testid="prefs-language">
                  <option value="en">English</option><option value="hi">Hindi</option>
                </select>
              </label>
            </div>
            <div>
              <div className="overline mb-2">Preferred Sectors</div>
              <div className="flex flex-wrap gap-2">
                {SECTORS.map((s) => {
                  const on = (prefs.preferred_sectors || []).includes(s);
                  return (
                    <button key={s} onClick={() => toggleSector(s)} data-testid={`sector-chip-${s}`}
                            className={`badge ${on ? "badge-bullish" : "badge-avoid"}`} style={{ cursor: "pointer" }}>{s}</button>
                  );
                })}
              </div>
            </div>
            <label className="flex flex-col gap-1.5"><span className="overline">Watchlist (comma-separated symbols)</span>
              <input className="input" value={(prefs.watchlist || []).join(", ")}
                     onChange={(e) => setPrefs({ ...prefs, watchlist: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })}
                     data-testid="prefs-watchlist" />
            </label>
            <div><button className="btn btn-primary" onClick={save} disabled={saving || showSkeletons} data-testid="prefs-save-btn">{saving ? "Saving…" : "Save preferences"}</button></div>
          </>
        )}
      </section>

      <section className="panel p-5 flex flex-col gap-4" data-testid="change-password-section">
        <div className="overline">Security</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5"><span className="overline">Current password</span>
            <input className="input" type="password" value={pw.current_password}
                   onChange={(e) => setPw({ ...pw, current_password: e.target.value })} data-testid="pw-current" />
          </label>
          <label className="flex flex-col gap-1.5"><span className="overline">New password (min 6 characters)</span>
            <input className="input" type="password" value={pw.new_password} minLength={6}
                   onChange={(e) => setPw({ ...pw, new_password: e.target.value })} data-testid="pw-new" />
          </label>
        </div>
        <div><button className="btn btn-outline" onClick={changePw} disabled={pwSaving} data-testid="change-password-btn">{pwSaving ? "Saving…" : "Change password"}</button></div>
      </section>
    </div>
  );
}
