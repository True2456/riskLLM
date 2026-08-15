/**
 * E2E: a full RiskLLM game played THROUGH the MCP endpoint.
 * The "agent" (p1) talks to the worker exactly like a real LLM client would
 * (JSON-RPC over Streamable HTTP, bearer token) — but its brain is the engine's
 * house-bot, so we can watch a complete game to the end automatically.
 *
 * Run:  npx tsx scripts/e2e-agent.ts   (with `npm run dev:worker` on :8787)
 */
import { botMove, type GameState } from "@riskllm/engine";

const BASE = process.env.WORKER_URL ?? "http://localhost:8787";

class Mcp {
  constructor(private token: string) {}

  private async rpc(method: string, params: unknown, id: number): Promise<any> {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop();
    }
    if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (data.error) throw new Error(`${method} -> ${JSON.stringify(data.error)}`);
    return data.result;
  }

  tool(name: string, args: Record<string, unknown> = {}): Promise<GameState & Record<string, unknown>> {
    return this.rpc("tools/call", { name, arguments: args }, Date.now() % 100000).then((r: any) =>
      JSON.parse(r.content[0].text),
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. create a room: one agent seat + two house bots
  const create = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "blitz",
      seats: [{ kind: "agent", name: "E2E-Agent" }, { kind: "bot", botStyle: "aggressive" }, { kind: "bot", botStyle: "turtle" }],
    }),
  }).then((r) => r.json() as Promise<any>);
  if (!create.gameId) throw new Error("room create failed: " + JSON.stringify(create));
  const { gameId, tokens } = create;
  console.log(`room ${gameId} created (spectate: ${BASE}/game/${gameId})`);
  const mcp = new Mcp(tokens.p1);

  await mcp.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 1);
  const tools = await mcp.rpc("tools/list", {}, 2);
  console.log(`MCP ok — ${tools.tools.length} tools available`);

  const start = Date.now();
  let actions = 0;
  let lastFeedSeq = 0;

  // raw state via REST (the harness's own view); actions go through MCP
  const rawState = async (): Promise<GameState> =>
    (await fetch(`${BASE}/api/rooms/${gameId}`).then((r) => r.json() as Promise<any>)).state;

  // 2. main loop: wait for my turn -> act with the bot brain -> repeat
  for (;;) {
    const wait = (await mcp.tool("risk_wait_for_turn", { max_wait_s: 25 })) as any;
    if (wait.game_over) break;
    if (!wait.your_turn) continue; // it was not my turn within the window; re-wait

    // act until the turn ends
    for (let i = 0; i < 60; i++) {
      const state = await rawState();
      if (state.status === "over") break;
      const move = botMove(state, "p1", "balanced");
      if (!move) break;
      actions++;
      let res: any;
      switch (move.t) {
        case "deploy":
          res = await mcp.tool("risk_deploy", { territory: move.territory, n: move.n });
          break;
        case "trade_cards":
          res = await mcp.tool("risk_trade_cards");
          break;
        case "end_reinforce":
          res = await mcp.tool("risk_end_reinforce");
          break;
        case "attack":
          res = await mcp.tool("risk_attack", { from: move.from, to: move.to, dice: move.dice });
          break;
        case "move":
          res = await mcp.tool("risk_move", { from: move.from, to: move.to, n: move.n });
          break;
        case "pass_combat":
          res = await mcp.tool("risk_pass_combat");
          break;
        case "fortify":
          res = await mcp.tool("risk_fortify", { from: move.from, to: move.to, n: move.n });
          break;
        case "end_turn":
          res = await mcp.tool("risk_end_turn");
          break;
        case "resign":
          res = await mcp.tool("risk_resign");
          break;
        default:
          throw new Error("unknown move " + (move as any).t);
      }
      if (!res.ok) console.log(`  ⚠ rejected: ${res.error}`);
      if (move.t === "end_turn" || move.t === "resign") break;
    }

    // safety: the brain never ended its turn within the action cap — force it
    const stMid = (await mcp.tool("risk_status")) as any;
    if (stMid.status === "running" && stMid.yourTurn) {
      await mcp.tool("risk_end_turn");
      console.log("  ⚠ forced end_turn after action cap");
    }

    // feed progress
    const st = await rawState();
    const newLines = st.feed.slice(lastFeedSeq);
    lastFeedSeq = st.feed.length;
    for (const l of newLines.filter((l) => l.playerId === "p1" && l.kind !== "turn")) {
      console.log(`  t${l.turn} ${l.kind}: ${l.text}`);
    }
    if (st.status === "over") break;
  }

  const final = await rawState();
  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\nGAME OVER after ${mins} min, ${actions} MCP actions`);
  const winnerName = final.players.find((p) => p.id === final.winner)?.name ?? final.winner ?? "?";
  console.log(`winner: ${winnerName} — ${final.winReason ?? "?"}`);
  console.log(`turn: ${final.turn}, feed lines: ${final.feed.length}`);
  for (const l of final.feed.filter((l) => l.kind === "conquest" || l.kind === "game").slice(-10)) {
    console.log(`  t${l.turn} ${l.text}`);
  }
}

main().catch((e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
