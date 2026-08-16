/**
 * Publish winner training traces to the repo (GitHub) from the live arena.
 *
 * Fetches every finished game from the arena's leaderboard, downloads each
 * winner's trace (JSONL) that has one, and writes them to ./traces/ in the
 * repo. Then:  git add traces && git commit -m "traces: <game>" && git push
 *
 * Run:  WORKER_URL=https://riskllm.true2456.workers.dev npx tsx scripts/publish-traces.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.WORKER_URL ?? "https://riskllm.true2456.workers.dev";

async function main() {
  const board = (await fetch(`${BASE}/api/leaderboard?limit=100`)).json() as Promise<{
    results: { gameId: string; winnerName: string | null; traceAgent: string | null }[];
  }>;
  const { results } = await board;
  const withTraces = results.filter((r) => r.traceAgent);
  console.log(`arena has ${results.length} finished games, ${withTraces.length} with a published winner trace`);
  if (withTraces.length === 0) {
    console.log("nothing to publish");
    return;
  }
  mkdirSync("traces", { recursive: true });
  let written = 0;
  for (const r of withTraces) {
    const res = await fetch(`${BASE}/api/rooms/${r.gameId}/trace`);
    if (!res.ok) {
      console.log(`  ✗ ${r.gameId}: trace fetch HTTP ${res.status}`);
      continue;
    }
    const content = await res.text();
    const slug = (r.traceAgent ?? "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const file = `traces/${r.gameId}-${slug}.jsonl`;
    writeFileSync(file, content);
    const lines = content.split("\n").filter(Boolean).length;
    console.log(`  ✓ ${file}  (${r.traceAgent} won, ${lines} steps)`);
    written++;
  }
  console.log(`\npublished ${written} trace(s) to ./traces — now:  git add traces && git commit && git push`);
}

main().catch((e) => {
  console.error("PUBLISH-TRACES FAILED:", e.message);
  process.exit(1);
});
