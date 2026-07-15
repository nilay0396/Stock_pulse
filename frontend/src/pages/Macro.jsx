import { LineChart, Line, ResponsiveContainer } from "recharts";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, fmtPct, pctColor } from "../lib/fmt";
import { SkeletonTableRows, ShimmerLine } from "../components/SkeletonBits";

const GRID = [
  ["NIFTY","BANKNIFTY","INDIAVIX","USDINR"],
  ["SP500","NASDAQ","DXY","US10Y"],
  ["CRUDE","BRENT","GOLD","SILVER"],
  ["COPPER","BTC","NIKKEI","HANGSENG"],
];

export default function Macro() {
  const { data: macroResp, loading: lMacro } = useCached("macro:all",
    () => api.get("/macro").then((r) => r.data));
  const { data: sectors = [], loading: lSectors } = useCached("macro:sectors",
    () => api.get("/macro/sectors").then((r) => r.data));
  const data = macroResp?.data || {};
  const showMacroSk = lMacro && !macroResp;
  const showSectorSk = lSectors && sectors.length === 0;

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Macro Terminal</div>
        <h1 className="font-heading text-3xl">Global & India Macro</h1>
      </header>

      <div className="flex flex-col gap-4">
        {GRID.map((row, rIdx) => (
          <div key={rIdx} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {row.map((k) => {
              const m = data[k];
              return (
                <div key={k} className="panel p-4" data-testid={`macro-card-${k}`}>
                  <div className="flex items-center justify-between">
                    <span className="overline">{k}</span>
                    <span className="font-mono text-[11px]" style={{ color: pctColor(m?.change_pct) }}>
                      {showMacroSk ? <ShimmerLine w={40} h={10} /> : (m ? fmtPct(m.change_pct) : "—")}
                    </span>
                  </div>
                  <div className="font-mono text-[22px] mt-1">
                    {showMacroSk ? <ShimmerLine w={80} h={20} /> : (m ? fmtNum(m.last) : "—")}
                  </div>
                  <div style={{ height: 52 }} className="mt-2 -mx-2">
                    {showMacroSk ? <ShimmerLine w="100%" h={52} /> :
                      m?.history?.length ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={m.history}>
                            <Line type="monotone" dataKey="close" stroke="#E4E4E7" strokeWidth={1.5} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <section className="panel p-5" data-testid="sector-table">
        <div className="overline mb-3">Sector Breadth</div>
        <table className="w-full data-table">
          <thead><tr><th>Sector</th><th className="numeric">Count</th><th className="numeric">1D</th><th className="numeric">1W</th><th className="numeric">1M</th></tr></thead>
          <tbody>
            {showSectorSk ? <SkeletonTableRows cols={5} rows={8} /> : sectors.map((s) => (
              <tr key={s.sector}>
                <td>{s.sector}</td>
                <td className="numeric">{s.count}</td>
                <td className="numeric" style={{ color: pctColor(s.day_pct) }}>{fmtPct(s.day_pct)}</td>
                <td className="numeric" style={{ color: pctColor(s.week_pct) }}>{fmtPct(s.week_pct)}</td>
                <td className="numeric" style={{ color: pctColor(s.month_pct) }}>{fmtPct(s.month_pct)}</td>
              </tr>
            ))}
            {!showSectorSk && sectors.length === 0 && <tr><td colSpan={5} className="text-center py-8" style={{ color: "var(--text-muted)" }}>No sector data yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
