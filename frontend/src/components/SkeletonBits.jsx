/**
 * Institutional-feel skeleton primitives for section-level loading states.
 * Tuned to the dark palette (surface-elevated + subtle pulse) used across the app.
 */
import { Skeleton } from "./ui/skeleton";

export function ShimmerLine({ w = "100%", h = 12, className = "" }) {
  return (
    <Skeleton
      className={`bg-[var(--surface-elevated)] ${className}`}
      style={{ width: w, height: h }}
    />
  );
}

/** A row of shimmer cells matching a table layout. */
export function SkeletonTableRows({ cols = 5, rows = 6, heights = 14 }) {
  const arr = Array.from({ length: rows });
  const cArr = Array.from({ length: cols });
  return (
    <>
      {arr.map((_, r) => (
        <tr key={`sk-${r}`} data-testid="skeleton-row">
          {cArr.map((_, c) => (
            <td key={c}>
              <ShimmerLine h={heights} w={c === 0 ? "70%" : c === cols - 1 ? "60%" : "85%"} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Card-style shimmer block for dashboards / macro tiles. */
export function SkeletonCard({ lines = 2, className = "" }) {
  return (
    <div className={`panel-elevated p-3 ${className}`} data-testid="skeleton-card">
      <ShimmerLine w="40%" h={10} />
      <div className="mt-2 flex flex-col gap-1.5">
        {Array.from({ length: lines }).map((_, i) => (
          <ShimmerLine key={i} w={i === 0 ? "80%" : "55%"} h={14} />
        ))}
      </div>
    </div>
  );
}

/** Narrative / paragraph block. */
export function SkeletonParagraph({ lines = 4 }) {
  return (
    <div className="flex flex-col gap-2" data-testid="skeleton-paragraph">
      {Array.from({ length: lines }).map((_, i) => {
        const w = [98, 92, 88, 72][i % 4];
        return <ShimmerLine key={i} w={`${w}%`} h={11} />;
      })}
    </div>
  );
}

/** List of shimmer rows (for flat lists — news, ideas rail). */
export function SkeletonList({ rows = 6, height = 30 }) {
  return (
    <div className="flex flex-col gap-2" data-testid="skeleton-list">
      {Array.from({ length: rows }).map((_, i) => (
        <ShimmerLine key={i} h={height} />
      ))}
    </div>
  );
}
