import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { Activity } from "lucide-react";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      toast.success("Welcome back");
      nav(loc.state?.from?.pathname || "/", { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2" style={{ background: "var(--bg)" }}>
      <div
        className="hidden lg:flex relative items-end p-12"
        style={{
          background: `
            radial-gradient(1200px 800px at 20% 30%, rgba(0,163,108,0.12), transparent 60%),
            radial-gradient(1000px 700px at 80% 70%, rgba(228,228,231,0.06), transparent 60%),
            linear-gradient(180deg, #08080A, #050505)`,
          borderRight: "1px solid var(--border)",
        }}
      >
        <div className="absolute inset-0 opacity-[0.05] pointer-events-none"
             style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent 0 23px, rgba(244,244,245,0.6) 23px 24px), repeating-linear-gradient(90deg, transparent 0 23px, rgba(244,244,245,0.6) 23px 24px)" }} />
        <div className="relative max-w-md">
          <div className="overline mb-4">Institutional Market Intelligence</div>
          <h1 className="font-heading text-5xl leading-none">Market Pulse<br/>India</h1>
          <p className="mt-6 text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Global macro, Indian equities, sector breadth, company fundamentals and analyst
            sentiment — synthesised into a single 7:00 AM IST decision-ready brief.
          </p>
          <div className="mt-10 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            <Activity size={12} color="var(--bullish)" />
            <span className="font-mono">Claude Sonnet 4.5 · yfinance · APScheduler</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-sm">
          <div className="overline mb-3">Sign in</div>
          <h2 className="font-heading text-3xl mb-8">Access the terminal</h2>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="overline">Email</span>
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} required type="email" data-testid="login-email" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="overline">Password</span>
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} required type="password" data-testid="login-password" />
            </label>
            <button disabled={loading} className="btn btn-primary justify-center mt-2" data-testid="login-submit-btn">
              {loading ? "Authenticating…" : "Sign in"}
            </button>
          </form>
          <div className="mt-6 text-[12px]" style={{ color: "var(--text-muted)" }}>
            New here? <Link className="underline" to="/register" data-testid="go-register-link">Create a free account</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
