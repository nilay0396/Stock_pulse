import { useEffect, useState } from "react";
import api from "../lib/api";
import { fmtNum, fmtPct, pctColor } from "../lib/fmt";

const TICKERS = ["NIFTY", "BANKNIFTY", "INDIAVIX", "USDINR", "DXY", "SP500", "CRUDE", "GOLD", "US10Y"];

export default function TopTicker() {
  const [data, setData] = useState({});
  const [runDate, setRunDate] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get("/macro");
        setData(data.data || {});
        setRunDate(data.run_date || null);
      } catch (err) { console.debug("[top-ticker] load failed", err); }
    };
    load();
    const i = setInterval(load, 120000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="ticker-strip px-6 py-2 flex items-center gap-6 overflow-x-auto" data-testid="top-ticker">
      <div className="overline shrink-0">Live Pulse {runDate ? `· ${runDate}` : ""}</div>
      {TICKERS.map((k) => {
        const row = data[k];
        return (
          <div key={k} className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{k}</span>
            <span className="font-mono text-[13px]">{row ? fmtNum(row.last, k === "USDINR" ? 2 : 2) : "—"}</span>
            <span className="font-mono text-[11px]" style={{ color: pctColor(row?.change_pct) }}>
              {row ? fmtPct(row.change_pct) : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
