export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Number(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}
export function pctColor(v) {
  if (v === null || v === undefined || isNaN(v)) return "var(--text-muted)";
  return Number(v) >= 0 ? "var(--bullish)" : "var(--bearish)";
}
export function directionBadge(d) {
  const map = {
    bullish: "badge badge-bullish",
    bearish: "badge badge-bearish",
    watch: "badge badge-watch",
    avoid: "badge badge-avoid",
  };
  return map[d] || "badge badge-avoid";
}
export function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  } catch { return String(iso); }
}
export function fmtRupee(v, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return `₹${fmtNum(v, digits)}`;
}
