import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Activity, Check, X } from "lucide-react";
import { useAuth } from "../lib/auth";

// Lightweight password-strength heuristic — kept inline because we only
// need it on the register screen and the rules mirror the backend exactly.
function strength(pw) {
  const checks = {
    length: pw.length >= 8,
    letter: /[a-zA-Z]/.test(pw),
    digitOrSymbol: /[0-9!-/:-@[-`{-~]/.test(pw),
    mixedCase: /[a-z]/.test(pw) && /[A-Z]/.test(pw),
    longish: pw.length >= 12,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  // 0-2 weak, 3 ok, 4 strong, 5 great
  const labels = ["—", "Very weak", "Weak", "OK", "Strong", "Excellent"];
  const colors = ["#52525b", "#f87171", "#fb923c", "#facc15", "#4ade80", "#16a34a"];
  return { checks, score: passed, label: labels[passed] || "—", color: colors[passed] || "#52525b" };
}

function Rule({ ok, label }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono"
         style={{ color: ok ? "#4ade80" : "var(--text-muted)" }}>
      {ok ? <Check size={11} /> : <X size={11} />} {label}
    </div>
  );
}

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const s = useMemo(() => strength(password), [password]);
  const passwordsMatch = confirm.length > 0 && password === confirm;
  const meetsMinimum = s.checks.length && s.checks.letter && s.checks.digitOrSymbol;
  const canSubmit = email.includes("@") && password.length >= 8 && meetsMinimum && passwordsMatch;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) {
      toast.error("Fix the highlighted password issues first");
      return;
    }
    setLoading(true);
    try {
      await register(email.trim().toLowerCase(), password, name.trim());
      toast.success("Welcome — your account is ready");
      nav("/", { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Registration failed");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2" style={{ background: "var(--bg)" }}>
      <div className="hidden lg:flex relative items-end p-12"
           style={{
             background: `
               radial-gradient(1200px 800px at 20% 30%, rgba(0,163,108,0.12), transparent 60%),
               radial-gradient(1000px 700px at 80% 70%, rgba(228,228,231,0.06), transparent 60%),
               linear-gradient(180deg, #08080A, #050505)`,
             borderRight: "1px solid var(--border)",
           }}>
        <div className="absolute inset-0 opacity-[0.05] pointer-events-none"
             style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent 0 23px, rgba(244,244,245,0.6) 23px 24px), repeating-linear-gradient(90deg, transparent 0 23px, rgba(244,244,245,0.6) 23px 24px)" }} />
        <div className="relative max-w-md">
          <div className="overline mb-4">Create your account</div>
          <h1 className="font-heading text-5xl leading-none">Get the<br/>7:00 AM brief.</h1>
          <p className="mt-6 text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Daily Indian-equity trade ideas distilled from full NSE scan, global macro,
            and Claude-grade narrative — delivered to Telegram and email each morning.
          </p>
          <ul className="mt-6 text-[13px] flex flex-col gap-1.5" style={{ color: "var(--text-secondary)" }}>
            <li className="flex items-start gap-2"><Check size={14} color="var(--bullish)" /> Full-NSE 3-stage funnel (~2,170 stocks scanned daily)</li>
            <li className="flex items-start gap-2"><Check size={14} color="var(--bullish)" /> Live Stock Deep Dive — quote, technicals, F&amp;O, news, AI verdict</li>
            <li className="flex items-start gap-2"><Check size={14} color="var(--bullish)" /> Per-user Telegram + Gmail delivery, set in Preferences</li>
          </ul>
          <div className="mt-10 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            <Activity size={12} color="var(--bullish)" />
            <span className="font-mono">Free to register · no credit card</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-sm">
          <div className="overline mb-3">Sign up</div>
          <h2 className="font-heading text-3xl mb-8">Create your account</h2>
          <form onSubmit={submit} className="flex flex-col gap-4" data-testid="register-form">
            <label className="flex flex-col gap-1.5">
              <span className="overline">Name</span>
              <input className="input" placeholder="Your name" value={name}
                     onChange={(e) => setName(e.target.value)} maxLength={120}
                     data-testid="register-name" autoComplete="name" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="overline">Email</span>
              <input className="input" required type="email" autoComplete="email"
                     value={email} onChange={(e) => setEmail(e.target.value)}
                     data-testid="register-email" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="overline">Password</span>
              <input className="input" required type="password" autoComplete="new-password"
                     placeholder="At least 8 characters"
                     value={password} onChange={(e) => setPassword(e.target.value)}
                     data-testid="register-password" />
              {password.length > 0 && (
                <div className="flex flex-col gap-1.5 mt-1" data-testid="password-strength">
                  <div className="h-[4px] rounded-full overflow-hidden"
                       style={{ background: "var(--surface-elevated)" }}>
                    <div style={{
                      width: `${(s.score / 5) * 100}%`, height: "100%",
                      background: s.color, transition: "width 240ms",
                    }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono"
                       style={{ color: "var(--text-muted)" }}>
                    <span>strength</span>
                    <span style={{ color: s.color }}>{s.label}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    <Rule ok={s.checks.length} label="≥ 8 chars" />
                    <Rule ok={s.checks.letter} label="letter" />
                    <Rule ok={s.checks.digitOrSymbol} label="digit / symbol" />
                    <Rule ok={s.checks.mixedCase} label="upper + lower (recommended)" />
                  </div>
                </div>
              )}
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="overline">Confirm password</span>
              <input className="input" required type="password" autoComplete="new-password"
                     value={confirm} onChange={(e) => setConfirm(e.target.value)}
                     data-testid="register-confirm" />
              {confirm.length > 0 && (
                <div className="text-[11px] font-mono"
                     style={{ color: passwordsMatch ? "#4ade80" : "#f87171" }}
                     data-testid="register-confirm-feedback">
                  {passwordsMatch ? "Passwords match" : "Passwords do not match"}
                </div>
              )}
            </label>
            <button disabled={loading || !canSubmit} className="btn btn-primary justify-center mt-2"
                    data-testid="register-submit-btn">
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
          <div className="mt-6 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Already have an account?{" "}
            <Link className="underline" to="/login" data-testid="go-login-link">Sign in</Link>
          </div>
          <p className="mt-8 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            By creating an account you agree that the Market Pulse India brief is research,
            not investment advice. We never sell your data or send promotional email.
          </p>
        </div>
      </div>
    </div>
  );
}
