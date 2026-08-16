/**
 * E2E for the winner-training-trace flow (no LLM needed):
 *  1. create a 2p room (p1 = agent seat → has a token, p2 = bot)
 *  2. wait for it to finish
 *  3. assert: upload requires a bearer token (401 without one)
 *  4. upload a correctly-formatted synthetic trace as p1
 *  5. assert: if p1 WON  → the leaderboard flags traceAgent (the lobby shows
 *     the ⬇ button) and GET returns the exact content (winner path)
 *     if p1 LOST → traceAgent stays null (losing traces stored, not flagged)
 *     and GET still returns the content via the single-trace fallback
 *  6. loop until p1 wins so the winner path is covered (capped)
 *
 * Run:  WORKER_URL=https://riskllm.true2456.workers.dev npx tsx scripts/e2e-traces.ts
 */
const BASE = process.env.WORKER_URL ?? "http://localhost:8787";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a realistic single-step trace line (chat-format prompt -> completion). */
function syntheticTrace(gameId: string): string {
  const line = {
    game: gameId,
    agent: "SynthAgent",
    model: "test/model",
    turn: 1,
    step: 0,
    tools: [
      { type: "function", function: { name: "risk_deploy", description: "d", parameters: { type: "object" } } },
    ],
    messages: [
      { role: "system", content: "You are SynthAgent, commanding a country in Risk." },
      { role: "user", content: "Turn 1. Current state (JSON): {...}. Play your turn now with tools." },
    ],
    completion: {
      role: "assistant",
      content: "I should reinforce my weakest border first.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "risk_deploy", arguments: '{"where":"ALA","count":2}' } },
      ],
    },
  };
  return JSON.stringify(line, null, 0) + "\n";
}

async function waitForFinish(gameId: string): Promise<{ winner: string | null; winnerName: string | null }> {
  for (let i = 0; i < 120; i++) {
    const fin = (await fetch(`${BASE}/api/rooms/${gameId}`)).json() as Promise<any>;
    const s = (await fin).state;
    if (s.status === "over" && s.winner) {
      const name = s.players.find((p: any) => p.id === s.winner)?.name ?? s.winner;
      return { winner: s.winner, winnerName: name };
    }
    await sleep(2000);
  }
  throw new Error("game did not finish in time");
}

async function main() {
  let winnerPathTested = false;
  let loserPathTested = false;
  let attempt = 0;

  while (!(winnerPathTested && loserPathTested) && attempt < 8) {
    attempt++;
    const create = (await (await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "blitz", seats: [{ kind: "agent", name: `SynthAgent${attempt}` }, { kind: "bot" }] }),
    })).json()) as any;
    const { gameId, tokens } = create;
    const token = tokens.p1 as string;
    console.log(`\n--- attempt ${attempt}: room ${gameId} (p1 token ${token.slice(0, 12)}…)`);

    const fin = await waitForFinish(gameId);
    const p1Won = fin.winner === "p1";
    console.log(`  finished — winner ${fin.winner} (${fin.winnerName}) → ${p1Won ? "P1 (agent seat) WON" : "p1 lost"}`);

    // 3. auth: no token -> 401
    const noAuth = await fetch(`${BASE}/api/rooms/${gameId}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "X", content: "{}" }),
    });
    console.log(`  upload without token → HTTP ${noAuth.status} (expect 401) ${noAuth.status === 401 ? "✓" : "✗"}`);
    if (noAuth.status !== 401) throw new Error("expected 401 without token");

    // 4. upload a formatted trace as p1 (valid token)
    const content = syntheticTrace(gameId);
    const up = await fetch(`${BASE}/api/rooms/${gameId}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentName: `SynthAgent${attempt}`, model: "test/model", content, lines: 1 }),
    });
    const upBody = (await up.json()) as { ok?: boolean; error?: string };
    console.log(`  upload with token    → HTTP ${up.status} ${JSON.stringify(upBody)} ${up.status === 200 && upBody.ok ? "✓" : "✗"}`);
    if (up.status !== 200 || !upBody.ok) throw new Error("upload failed");

    // 5a. GET returns the exact content + is a download
    const dl = await fetch(`${BASE}/api/rooms/${gameId}/trace`);
    const dlText = await dl.text();
    const disp = dl.headers.get("content-disposition") ?? "";
    const isNdl = (dl.headers.get("content-type") ?? "").includes("ndjson");
    console.log(
      `  download               → HTTP ${dl.status}, ndjson=${isNdl}, disp="${disp}", bytes=${dlText.length} ` +
        `${dlText === content && isNdl ? "✓ exact content" : "✗ MISMATCH"}`,
    );
    if (dlText !== content || !isNdl) throw new Error("download content mismatch");
    const parsed = JSON.parse(dlText.trim());
    const okShape =
      parsed.messages?.length === 2 &&
      parsed.completion?.role === "assistant" &&
      Array.isArray(parsed.completion.tool_calls) &&
      Array.isArray(parsed.tools);
    console.log(`  trace shape            → messages=${parsed.messages?.length}, completion.role=${parsed.completion?.role}, tool_calls=${parsed.completion?.tool_calls?.length}, tools=${parsed.tools?.length} ${okShape ? "✓" : "✗"}`);
    if (!okShape) throw new Error("trace shape invalid");

    // 5b. leaderboard flag
    const lb = (await fetch(`${BASE}/api/leaderboard`)).json() as Promise<{ results: { gameId: string; traceAgent: string | null }[] }>;
    const row = (await lb).results.find((r) => r.gameId === gameId);
    const flagged = row?.traceAgent ?? null;
    if (p1Won) {
      console.log(`  leaderboard flag       → traceAgent=${JSON.stringify(flagged)} (expect "SynthAgent${attempt}") ${flagged === `SynthAgent${attempt}` ? "✓ WINNER path" : "✗"}`);
      if (flagged !== `SynthAgent${attempt}`) throw new Error("winner not flagged");
      winnerPathTested = true;
    } else {
      console.log(`  leaderboard flag       → traceAgent=${JSON.stringify(flagged)} (expect null — p1 lost) ${flagged === null ? "✓ LOSER path (stored, not flagged)" : "✗"}`);
      if (flagged !== null) throw new Error("loser was flagged");
      loserPathTested = true;
    }
  }

  if (!winnerPathTested) throw new Error("never observed a p1 (winner) trace in the attempts");
  console.log("\n✓ TRACES E2E OK — auth, formatted upload, exact download, winner-flag, loser-stored all verified");
}

main().catch((e) => {
  console.error("TRACES E2E FAILED:", e.message);
  process.exit(1);
});
