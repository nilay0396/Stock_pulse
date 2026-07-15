import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Play } from "lucide-react";
import api from "../lib/api";
import { fmtDate } from "../lib/fmt";
import StatusDot from "../components/StatusDot";

export default function AdminConnectors() {
  const [rows, setRows] = useState([]);
  const [ingestions, setIngestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [c, i] = await Promise.all([api.get("/admin/connectors"), api.get("/admin/ingestion-runs", { params: { limit: 30 } })]);
      setRows(c.data); setIngestions(i.data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const run = async (name) => {
    setRunning(name);
    try { await api.post(`/admin/connectors/${name}/run`); toast.success(`${name} executed`); await load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Connector failed"); }
    finally { setRunning(null); }
  };

  const seed = async () => {
    try { const { data } = await api.post("/admin/seed-universe"); toast.success(`Universe: ${data.total} symbols (new ${data.inserted})`); }
    catch (e) { toast.error("Seed failed"); }
  };

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header className="flex items-end justify-between">
        <div>
          <div className="overline">Control Room</div>
          <h1 className="font-heading text-3xl">Connectors</h1>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-outline" onClick={load} data-testid="refresh-connectors-btn"><RefreshCw size={14} /> Refresh</button>
          <button className="btn btn-outline" onClick={seed} data-testid="seed-universe-btn">Seed Universe</button>
        </div>
      </header>

      <div className="panel overflow-x-auto" data-testid="connectors-table">
        <table className="w-full data-table">
          <thead><tr>
            <th>Status</th><th>Name</th><th>Category</th><th>Last Run</th><th>Success</th><th>Failures</th><th>Avg ms</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><StatusDot status={r.last_status} /> <span className="ml-2 font-body text-[12px]">{r.last_status}</span></td>
                <td className="font-bold">{r.name}</td>
                <td className="font-body text-[12px]">{r.category}</td>
                <td>{fmtDate(r.last_run_at)}</td>
                <td className="numeric">{r.success_count || 0}</td>
                <td className="numeric" style={{ color: r.failure_count ? "var(--bearish)" : "var(--text-muted)" }}>{r.failure_count || 0}</td>
                <td className="numeric">{Math.round(r.avg_duration_ms || 0)}</td>
                <td>
                  <button className="btn btn-outline" onClick={() => run(r.name)} disabled={running === r.name} data-testid={`run-${r.name}-btn`}>
                    <Play size={12} /> {running === r.name ? "Running…" : "Run"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="panel p-5">
        <div className="overline mb-3">Recent Ingestion Runs</div>
        <table className="w-full data-table">
          <thead><tr><th>Status</th><th>Connector</th><th>Rows</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead>
          <tbody>
            {ingestions.map((i) => (
              <tr key={i.id}>
                <td><StatusDot status={i.status} /> <span className="ml-2 font-body text-[12px]">{i.status}</span></td>
                <td>{i.connector}</td>
                <td className="numeric">{i.rows || 0}</td>
                <td>{fmtDate(i.started_at)}</td>
                <td>{fmtDate(i.finished_at)}</td>
                <td className="font-body text-[12px]" style={{ color: "var(--bearish)" }}>{i.error || ""}</td>
              </tr>
            ))}
            {!loading && ingestions.length === 0 && <tr><td colSpan={6} className="text-center py-6" style={{ color: "var(--text-muted)" }}>No runs yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
