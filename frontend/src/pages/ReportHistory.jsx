import { Link } from "react-router-dom";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtDate } from "../lib/fmt";
import StatusDot from "../components/StatusDot";
import { SkeletonTableRows } from "../components/SkeletonBits";

export default function ReportHistory() {
  const { data: items = [], loading } = useCached("reports:history",
    () => api.get("/reports/history", { params: { limit: 50 } }).then((r) => r.data));
  const showSk = loading && items.length === 0;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Archive</div>
        <h1 className="font-heading text-3xl">Report History</h1>
      </header>
      <div className="panel overflow-x-auto" data-testid="reports-table">
        <table className="w-full data-table">
          <thead><tr>
            <th>Status</th><th>Run Date</th><th>Started</th><th>Finished</th><th>Triggered By</th><th>Ideas</th><th></th>
          </tr></thead>
          <tbody>
            {showSk ? <SkeletonTableRows cols={7} rows={8} /> : items.map((r) => (
              <tr key={r.id}>
                <td><StatusDot status={r.status} /> <span className="ml-2 font-body text-[12px]">{r.status}</span></td>
                <td>{r.run_date}</td>
                <td>{fmtDate(r.started_at)}</td>
                <td>{fmtDate(r.finished_at)}</td>
                <td className="font-body text-[12px]">{r.triggered_by}</td>
                <td className="numeric">{(r.summary?.top_weekly?.length || 0) + (r.summary?.top_monthly?.length || 0)}</td>
                <td><Link className="btn btn-ghost" to={`/reports/${r.id}`} data-testid={`open-report-${r.id}`}>Open →</Link></td>
              </tr>
            ))}
            {!showSk && items.length === 0 && <tr><td colSpan={7} className="text-center py-10" style={{ color: "var(--text-muted)" }}>No reports yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
