/**
 * CLI entry for the daily report pipeline (run by GitHub Actions).
 *   npx tsx pipeline/run.ts [--skip-llm] [--universe-limit N] [--force] [--expand-universe]
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 *   (unless --skip-llm), KITE_API_KEY (for the optional liquidity gate),
 *   FMP_API_KEY (optional).
 */
import { generateReport } from "../lib/pipeline/generateReport.js";
import { expandUniverseFromKite } from "../lib/pipeline/universe.js";

function getFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const skipLlm = getFlag("skip-llm");
  const force = getFlag("force");
  const expand = getFlag("expand-universe");
  const limitRaw = getValue("universe-limit");
  const universeLimit = limitRaw ? Number(limitRaw) : undefined;

  if (expand) {
    console.log("pipeline: expanding universe from kite_instruments...");
    const res = await expandUniverseFromKite();
    console.log(`pipeline: universe expanded — inserted=${res.inserted} total=${res.total}`);
  }

  const result = await generateReport({ skipLlm, force, universeLimit, triggeredBy: "github-actions" });
  console.log("pipeline result:", JSON.stringify(result));
  if (result.funnel) {
    console.log("pipeline funnel:", JSON.stringify(result.funnel));
  }

  if (result.status === "failed") process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("pipeline: fatal:", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
