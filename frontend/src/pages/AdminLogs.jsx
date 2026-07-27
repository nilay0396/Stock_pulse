import { useEffect, useState } from "react";
import api from "../lib/api";
import { fmtDate } from "../lib/fmt";
import ErrorState from "../components/ErrorState";

export default function AdminLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try { const { data } = await api.get("/admin/audit", { params: { limit: 200 } }); setLogs(data); }
    catch (e) { setLogs([]); setError(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Admin</div>
        <h1 className="font-heading text-3xl">Audit Logs</h1>
      </header>
      <ErrorState error={error} fallback="Audit logs failed to load." onRetry={load} />
      <div className="panel overflow-x-auto" data-testid="audit-table">
        <table className="w-full data-table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Meta</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{fmtDate(l.at)}</td>
                <td>{l.email}</td>
                <td>{l.action}</td>
                <td className="font-body text-[11px]" style={{ color: "var(--text-muted)" }}>{JSON.stringify(l.meta || {})}</td>
              </tr>
            ))}
            {!loading && !error && logs.length === 0 && <tr><td colSpan={4} className="text-center py-6" style={{ color: "var(--text-muted)" }}>No audit entries</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
