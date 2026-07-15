import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtDate } from "../lib/fmt";
import StatusDot from "../components/StatusDot";
import { SkeletonTableRows } from "../components/SkeletonBits";

export default function DeliveryLogs() {
  const { data: items = [], loading } = useCached("delivery:logs",
    () => api.get("/admin/deliveries").then((r) => r.data).catch(() => []));
  const showSk = loading && items.length === 0;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Logistics</div>
        <h1 className="font-heading text-3xl">Delivery Logs</h1>
      </header>
      <div className="panel overflow-x-auto" data-testid="deliveries-table">
        <table className="w-full data-table">
          <thead><tr>
            <th>Status</th><th>Channel</th><th>Recipient</th><th>Report</th><th>Created</th><th>Dry Run</th><th>Error</th>
          </tr></thead>
          <tbody>
            {showSk ? <SkeletonTableRows cols={7} rows={6} /> : items.map((d) => (
              <tr key={d.id}>
                <td><StatusDot status={d.status} /> <span className="ml-2 font-body text-[12px]">{d.status}</span></td>
                <td>{d.channel}</td>
                <td className="font-body text-[12px]">{d.recipient}</td>
                <td className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{(d.report_run_id || "").slice(0, 8)}</td>
                <td>{fmtDate(d.created_at)}</td>
                <td>{d.response_meta?.dry_run ? "yes" : "no"}</td>
                <td className="font-body text-[12px]" style={{ color: "var(--bearish)" }}>{d.error || ""}</td>
              </tr>
            ))}
            {!showSk && items.length === 0 && <tr><td colSpan={7} className="text-center py-10" style={{ color: "var(--text-muted)" }}>No deliveries yet. They are created when the morning report runs.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
        While Telegram / Gmail credentials are not set, deliveries are recorded in <b>DRY-RUN</b> mode.
      </div>
    </div>
  );
}
