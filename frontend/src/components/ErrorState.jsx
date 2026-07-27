import { AlertTriangle, RefreshCw } from "lucide-react";

function messageFrom(error, fallback) {
  return error?.response?.data?.detail || error?.message || fallback;
}

export default function ErrorState({ error, fallback = "Data failed to load.", onRetry }) {
  if (!error) return null;
  return (
    <div className="panel p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--bearish)" }}>
        <AlertTriangle size={15} />
        <span>{messageFrom(error, fallback)}</span>
      </div>
      {onRetry && (
        <button className="btn btn-outline" onClick={onRetry}>
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}
