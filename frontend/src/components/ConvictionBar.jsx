export default function ConvictionBar({ value, direction = "bullish" }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const color =
    direction === "bearish" ? "var(--bearish)" :
    direction === "watch"   ? "var(--watch)"   :
    direction === "avoid"   ? "var(--avoid)"   : "var(--bullish)";

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-[6px] rounded-sm overflow-hidden" style={{ background: "var(--border)" }}>
        <div style={{ width: `${v}%`, background: color, height: "100%", transition: "width 300ms ease" }} />
      </div>
      <span className="font-mono text-[12px] w-[34px] text-right tabular-nums">{Math.round(v)}</span>
    </div>
  );
}
