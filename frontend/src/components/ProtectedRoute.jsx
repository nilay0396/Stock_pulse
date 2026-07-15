import { Navigate, useLocation } from "react-router-dom";
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
  if (adminOnly && user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}
