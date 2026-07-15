import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/api";
import { useCached } from "../lib/cache";
import { fmtNum, fmtDate, pctColor, fmtPct } from "../lib/fmt";
import { SkeletonTableRows, SkeletonList } from "../components/SkeletonBits";

export default function Flows() {
  const [tab, setTab] = useState("macro");

  const { data: fii = [], loading: lFii } = useCached("flows:fii", () =>
    api.get("/flows/fii-dii", { params: { limit: 30 } }).then((r) => r.data));
  const { data: fred = [], loading: lFred } = useCached("flows:fred", () =>
    api.get("/flows/fred").then((r) => r.data));
  const { data: sectors = [], loading: lSectors } = useCached("flows:sectors", () =>
    api.get("/flows/sector-indices").then((r) => r.data));
  const { data: insider = [], loading: lInsider } = useCached("flows:insider", () =>
    api.get("/flows/insider", { params: { limit: 50 } }).then((r) => r.data));
  const { data: actions = [], loading: lActions } = useCached("flows:actions", () =>
    api.get("/flows/corporate-actions", { params: { limit: 60 } }).then((r) => r.data));
  const { data: ann = [], loading: lAnn } = useCached("flows:ann", () =>
    api.get("/flows/corporate-announcements", { params: { limit: 60 } }).then((r) => r.data));
  const { data: geo = [], loading: lGeo } = useCached("flows:geo", () =>
    api.get("/flows/geopolitics", { params: { limit: 20 } }).then((r) => r.data));

  // Dedupe FII/DII by date+category
  const fiiMap = {};
  for (const r of fii) {
    const k = `${r.date}__${r.category}`;
    if (!(k in fiiMap)) fiiMap[k] = r;
  }
  const fiiRows = Object.values(fiiMap).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const tabs = [
    { id: "macro",   label: "FII/DII · FRED" },
    { id: "sectors", label: "Sector Indices" },
    { id: "insider", label: "Insider" },
    { id: "events",  label: "Corporate Events" },
    { id: "geo",     label: "Geopolitics" },
  ];

  return (
    <div className="p-6 md:p-8 flex flex-col gap-5">
      <header>
        <div className="overline">Capital Flows & Corporate Intelligence</div>
        <h1 className="font-heading text-3xl">FII · DII · Insider · Corporate Events · Geopolitics</h1>
        <div className="text-[12px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
          Sourced from NSE (bhavcopy, allIndices, corporate-announcements, corporates-corporateActions, corporates-pit), FRED and GDELT.
        </div>
      </header>

      <div className="flex gap-1 border-b" style={{ borderColor: "var(--border)" }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} data-testid={`flow-tab-${t.id}`}
                  className="px-3 py-2 text-[12px] font-bold uppercase tracking-wider"
                  style={{
                    color: tab === t.id ? "var(--text-primary)" : "var(--text-muted)",
                    borderBottom: tab === t.id ? "2px solid var(--text-primary)" : "2px solid transparent",
                  }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "macro" && (
        <>
          <section className="panel p-5" data-testid="fii-dii-panel">
            <div className="overline mb-3">FII & DII Daily Flows (₹ Cr)</div>
            <table className="w-full data-table">
              <thead><tr><th>Date</th><th>Category</th><th className="numeric">Buy</th><th className="numeric">Sell</th><th className="numeric">Net</th></tr></thead>
              <tbody>
                {lFii && fiiRows.length === 0 ? <SkeletonTableRows cols={5} rows={6} /> : fiiRows.map((r) => (
                  <tr key={`${r.date}-${r.category}`}>
                    <td>{r.date}</td><td>{r.category}</td>
                    <td className="numeric">{fmtNum(r.buy_value, 0)}</td>
                    <td className="numeric">{fmtNum(r.sell_value, 0)}</td>
                    <td className="numeric" style={{ color: pctColor(r.net_value) }}>{fmtNum(r.net_value, 0)}</td>
                  </tr>
                ))}
                {!lFii && fiiRows.length === 0 && <tr><td colSpan={5} className="text-center py-8" style={{ color: "var(--text-muted)" }}>No flow data yet.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel p-5" data-testid="fred-panel">
            <div className="overline mb-3">FRED Macro Snapshot</div>
            {lFred && fred.length === 0 ? (
              <SkeletonList rows={5} height={22} />
            ) : fred.length === 0 ? (
              <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                No FRED data yet. Add your free FRED API key in <Link to="/admin/settings" className="underline">Admin → Settings</Link>.
              </div>
            ) : (
              <table className="w-full data-table">
                <thead><tr><th>Series</th><th>Date</th><th className="numeric">Value</th><th className="numeric">Δ prev</th></tr></thead>
                <tbody>
                  {fred.map((r) => (
                    <tr key={r.series_id || r.key}>
                      <td className="font-bold">{r.key || r.series_id}</td>
                      <td>{r.date}</td>
                      <td className="numeric">{fmtNum(r.value, 3)}</td>
                      <td className="numeric" style={{ color: pctColor(r.change) }}>{r.change != null ? fmtNum(r.change, 3) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === "sectors" && (
        <section className="panel p-5" data-testid="sector-indices-panel">
          <div className="overline mb-3">NSE Sector Indices (live P/E, P/B)</div>
          <div className="overflow-x-auto">
            <table className="w-full data-table">
              <thead><tr>
                <th>Index</th><th className="numeric">Last</th><th className="numeric">%Chg</th>
                <th className="numeric">P/E</th><th className="numeric">P/B</th><th className="numeric">Div Yield</th>
                <th className="numeric">52W High</th><th className="numeric">52W Low</th>
              </tr></thead>
              <tbody>
                {lSectors && sectors.length === 0 ? <SkeletonTableRows cols={8} rows={8} /> : sectors.map((r) => (
                  <tr key={r.index}>
                    <td className="font-bold">{r.index}</td>
                    <td className="numeric">{fmtNum(r.last, 2)}</td>
                    <td className="numeric" style={{ color: pctColor(r.change_pct) }}>{fmtPct(r.change_pct)}</td>
                    <td className="numeric">{r.pe ?? "—"}</td>
                    <td className="numeric">{r.pb ?? "—"}</td>
                    <td className="numeric">{r.div_yield ?? "—"}</td>
                    <td className="numeric">{fmtNum(r.year_high, 2)}</td>
                    <td className="numeric">{fmtNum(r.year_low, 2)}</td>
                  </tr>
                ))}
                {!lSectors && sectors.length === 0 && <tr><td colSpan={8} className="text-center py-8" style={{ color: "var(--text-muted)" }}>No sector index data yet. Run the engine.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "insider" && (
        <section className="panel p-5" data-testid="insider-panel">
          <div className="overline mb-3">Insider / PIT Disclosures (last 30d)</div>
          <div className="overflow-x-auto">
            <table className="w-full data-table">
              <thead><tr>
                <th>Disclosure</th><th>Symbol</th><th>Acquirer</th><th>Category</th>
                <th>Type</th><th className="numeric">Shares</th><th className="numeric">Value (₹ Cr)</th>
              </tr></thead>
              <tbody>
                {lInsider && insider.length === 0 ? <SkeletonTableRows cols={7} rows={8} /> : insider.map((r, i) => (
                  <tr key={`${r.disclosure_date}-${r.symbol}-${r.acquirer}-${i}`}>
                    <td className="font-body text-[11px]">{r.disclosure_date}</td>
                    <td className="font-bold"><Link to={`/explorer/${r.symbol}`} className="hover:underline">{r.symbol}</Link></td>
                    <td className="font-body text-[12px]">{r.acquirer}</td>
                    <td className="font-body text-[12px]">{r.category || "—"}</td>
                    <td className="font-body text-[12px]">{r.tx_type || "—"}</td>
                    <td className="numeric">{r.shares ? fmtNum(r.shares, 0) : "—"}</td>
                    <td className="numeric">{r.value ? fmtNum((r.value || 0) / 1e7, 2) : "—"}</td>
                  </tr>
                ))}
                {!lInsider && insider.length === 0 && <tr><td colSpan={7} className="text-center py-8" style={{ color: "var(--text-muted)" }}>No insider data yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "events" && (
        <>
          <section className="panel p-5" data-testid="corp-actions-panel">
            <div className="overline mb-3">Upcoming Corporate Actions (Dividend · Split · Bonus · Buyback)</div>
            <div className="overflow-x-auto">
              <table className="w-full data-table">
                <thead><tr><th>Symbol</th><th>Subject</th><th>Ex-date</th><th>Record date</th><th className="numeric">Face Val</th></tr></thead>
                <tbody>
                  {lActions && actions.length === 0 ? <SkeletonTableRows cols={5} rows={6} /> : actions.map((r, i) => (
                    <tr key={`${r.symbol}-${r.ex_date}-${r.subject}-${i}`}>
                      <td className="font-bold">{r.symbol}</td>
                      <td className="font-body text-[12px]">{r.subject}</td>
                      <td>{r.ex_date}</td>
                      <td>{r.record_date || "—"}</td>
                      <td className="numeric">{r.face_value ?? "—"}</td>
                    </tr>
                  ))}
                  {!lActions && actions.length === 0 && <tr><td colSpan={5} className="text-center py-8" style={{ color: "var(--text-muted)" }}>No upcoming actions. Run the engine.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel p-5" data-testid="corp-ann-panel">
            <div className="overline mb-3">Corporate Announcements</div>
            {lAnn && ann.length === 0 ? <SkeletonList rows={8} height={28} /> : (
              <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
                {ann.map((a, i) => (
                  <a key={a.attachment || `${a.symbol}-${a.disclosure_time}-${i}`} className="py-2 hover:bg-[var(--surface-elevated)] px-1 -mx-1" target="_blank" rel="noreferrer" href={a.attachment}>
                    <div className="flex justify-between gap-4">
                      <div className="text-[13px]"><span className="font-bold">{a.symbol}</span> · {a.description}</div>
                      <div className="text-[11px] font-mono whitespace-nowrap" style={{ color: "var(--text-muted)" }}>{a.disclosure_time}</div>
                    </div>
                  </a>
                ))}
                {ann.length === 0 && <div className="py-4 text-[12px]" style={{ color: "var(--text-muted)" }}>No announcements ingested yet.</div>}
              </div>
            )}
          </section>
        </>
      )}

      {tab === "geo" && (
        <section className="panel p-5" data-testid="geo-panel">
          <div className="overline mb-3">Geopolitics · India Macro News (GDELT)</div>
          {lGeo && geo.length === 0 ? <SkeletonList rows={8} height={32} /> : (
            <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
              {geo.map((g, i) => (
                <a key={g.url || `${g.title}-${i}`} className="py-2 hover:bg-[var(--surface-elevated)] px-1 -mx-1" target="_blank" rel="noreferrer" href={g.url}>
                  <div className="text-[13px]">{g.title}</div>
                  <div className="text-[11px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
                    {g.source} · {g.country} · {fmtDate(g.ingested_at)}
                  </div>
                </a>
              ))}
              {geo.length === 0 && <div className="py-4 text-[12px]" style={{ color: "var(--text-muted)" }}>No geopolitics events ingested yet.</div>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
