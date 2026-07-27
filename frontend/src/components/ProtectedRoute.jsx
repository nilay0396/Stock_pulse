import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>Loading…</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (adminOnly && user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "var(--bg)" }}>
        <div className="panel p-6 max-w-md w-full">
          <div className="overline">Access Restricted</div>
          <h1 className="font-heading text-2xl mt-1">Admin permission required</h1>
          <p className="text-[13px] mt-3" style={{ color: "var(--text-secondary)" }}>
            This page is available only to admin users.
          </p>
          <Link className="btn btn-outline mt-5" to="/">Return to dashboard</Link>
        </div>
      </div>
    );
  }
  return children;
}
