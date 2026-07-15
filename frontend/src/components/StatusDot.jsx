export default function StatusDot({ status = "idle" }) {
  const cls = {
    success: "dot-ok",
    failed: "dot-fail",
    running: "dot-warn",
    idle: "dot-idle",
    sent: "dot-ok",
    dry_run: "dot-warn",
    pending: "dot-warn",
  }[status] || "dot-idle";
  return <span className={`status-dot ${cls}`} title={status} />;
}
