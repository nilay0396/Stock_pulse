/**
 * Commodity -> Indian sector impact mapping.
 * Ported 1:1 from backend/services/commodity_mapping.py.
 *
 * Each commodity move produces a signed impact [-1, +1] per sector.
 * Positive impact boosts a sector's macro_sector score; negative drags it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

export const COMMODITY_SECTOR_IMPACT: Record<string, Record<string, number>> = {
  CRUDE: {
    Energy: 0.5,
    Chemicals: -0.7,
    Auto: -0.3,
    FMCG: -0.2,
    Cement: -0.3,
    Infrastructure: -0.2,
  },
  BRENT: {
    Energy: 0.5,
    Chemicals: -0.7,
    Auto: -0.3,
    FMCG: -0.2,
    Cement: -0.3,
    Infrastructure: -0.2,
  },
  GOLD: {
    Consumer: -0.5,
    Banking: 0.1,
    "Financial Services": 0.1,
  },
  SILVER: {
    Consumer: -0.3,
    Chemicals: 0.2,
  },
  COPPER: {
    Metals: 0.6,
    Infrastructure: 0.3,
    Power: 0.2,
    Auto: 0.1,
  },
  NATGAS: {
    Energy: 0.3,
    Chemicals: -0.4,
    Power: -0.2,
  },
  DXY: {
    IT: 0.4,
    Pharma: 0.3,
    Metals: -0.3,
    Auto: -0.2,
    FMCG: -0.1,
  },
  US10Y: {
    Banking: 0.1,
    "Financial Services": -0.2,
    Auto: -0.2,
    Infrastructure: -0.2,
  },
};

export function commodityDeltas(macro: Dict): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(COMMODITY_SECTOR_IMPACT)) {
    const row = macro[k] || {};
    out[k] = row.change_pct || 0.0;
  }
  return out;
}

export function sectorImpactScores(macro: Dict): Record<string, number> {
  const deltas = commodityDeltas(macro);
  const raw: Record<string, number> = {};
  for (const [comm, impactMap] of Object.entries(COMMODITY_SECTOR_IMPACT)) {
    const delta = deltas[comm] ?? 0.0;
    for (const [sector, weight] of Object.entries(impactMap)) {
      raw[sector] = (raw[sector] ?? 0.0) + weight * delta;
    }
  }
  const out: Record<string, number> = {};
  for (const [s, v] of Object.entries(raw)) {
    out[s] = Math.max(-15.0, Math.min(15.0, v));
  }
  return out;
}

const ALL_MAPPED_SECTORS = new Set(
  Object.values(COMMODITY_SECTOR_IMPACT).flatMap((m) => Object.keys(m)),
);

export function explain(sector: string, _impact: number, macro: Dict): string[] {
  if (!sector || !ALL_MAPPED_SECTORS.has(sector)) return [];
  const notes: string[] = [];
  for (const [comm, impactMap] of Object.entries(COMMODITY_SECTOR_IMPACT)) {
    if (!(sector in impactMap)) continue;
    const delta = (macro[comm] || {}).change_pct || 0.0;
    const weight = impactMap[sector];
    const effect = weight * delta;
    if (Math.abs(effect) < 0.3) continue;
    const direction = effect > 0 ? "tailwind" : "headwind";
    const sign = delta >= 0 ? "+" : "";
    notes.push(`${comm} ${sign}${delta.toFixed(1)}% is a ${direction} for ${sector}`);
  }
  return notes.slice(0, 3);
}
