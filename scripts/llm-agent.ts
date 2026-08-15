/**
 * A real LLM plays RiskLLM through the MCP endpoint.
 *
 * The agent is exactly what a user's MCP client would be: it sees only the 12
 * risk_* tools (fetched from /mcp) and talks to them over JSON-RPC. Its "brain"
 * is an OpenAI-compatible chat endpoint (default: OpenRouter
 * `nvidia/nemotron-3.5-lightning:free`).
 *
 * Loop:  wait_for_turn (long-poll) -> LLM plays its turn with tool calls
 *        (executed via MCP, results fed back) -> end_turn -> repeat.
 * Context: at each turn boundary the conversation is compacted to a rolling
 * summary so free-tier context windows never blow up.
 *
 * Run:  WORKER_URL=http://localhost:8787 \
 *       OPENROUTER_KEY=sk-or-... \
 *       npx tsx scripts/llm-agent.ts
 */

// ---------------------------------------------------------------- config

const BASE = process.env.WORKER_URL ?? "http://localhost:8787";
const LLM_URL =
  process.env.LLM_URL ?? "https://openrouter.ai/api/v1/chat/completions";
const LLM_KEY = process.env.OPENROUTER_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-3.5-lightning:free";
const AGENT_NAME = process.env.AGENT_NAME ?? "Nemotron";
const MAX_ACTIONS_PER_TURN = 30;
const MAX_TURNS = 40;

if (!LLM_KEY) {
  console.error("set OPENROUTER_KEY");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- MCP client

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
      data = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
        .pop();
    }
    if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (data.error) throw new Error(`${method} -> ${JSON.stringify(data.error)}`);
    return data.result;
  }

  /** call a tool; returns the parsed JSON content (all risk tools return JSON) */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.rpc("tools/call", { name, arguments: args }, Date.now() % 1000000);
    try {
      return JSON.parse(r.content[0].text);
    } catch {
      return { raw: r.content[0].text };
    }
  }
}

// ---------------------------------------------------------------- LLM client

interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

async function llm(tools: any[], messages: Msg[]): Promise<Msg> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(LLM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${LLM_KEY}`,
          "HTTP-Referer": "http://localhost",
          "X-Title": "riskllm-agent",
        },
        body: JSON.stringify({ model: LLM_MODEL, messages, tools, tool_choice: "auto", temperature: 0.8, max_tokens: 1500 }),
      });
      if (res.status === 429) {
        const wait = 8000 * (attempt + 1);
        console.log(`  .. rate limited, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      const m = data.choices[0].message as any;
      return {
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    } catch (e) {
      lastErr = e;
      await sleep(5000 * (attempt + 1));
    }
  }
  throw new Error("LLM calls failed after retries: " + String(lastErr));
}

// ---------------------------------------------------------------- agent

interface Chat {
  /** rolling one-line state summary, rebuilt at every turn boundary */
  summary: string;
}

async function main() {
  // 1. room: one agent seat + two house bots (blitz, 3p)
  const create = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "blitz",
      seats: [
        { kind: "agent", name: AGENT_NAME },
        { kind: "bot", botStyle: "balanced" },
        { kind: "bot", botStyle: "aggressive" },
      ],
    }),
  }).then((r) => r.json() as Promise<any>);
  if (!create.gameId) throw new Error("room create failed: " + JSON.stringify(create));
  const { gameId, tokens } = create;
  console.log(`room ${gameId} — ${AGENT_NAME} plays seat p1 (spectate: ${BASE}/game/${gameId})`);

  const mcp = new Mcp(tokens.p1);
  await mcp.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: AGENT_NAME, version: "1" } }, 1);
  const mcpTools = await mcp.rpc("tools/list", {}, 2).then((r: any) => r.tools);
  const tools = mcpTools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  console.log(`MCP ok — ${tools.length} tools, LLM = ${LLM_MODEL}`);

  const system = `You are ${AGENT_NAME}, commanding a country in a live game of Risk (RiskLLM).
You play through tools — the ONLY way to act is calling a tool. Territory args accept the id (e.g. "ALA") or the name (e.g. "Alaska").
Strategy: consolidate one continent early; attack 1-army tiles with 2 dice, 2-army tiles with 3; fortify to keep borders strong; trade cards when you have 3. When your turn ends, call risk_end_turn. If hopeless, risk_resign. You may risk_chat (short, max 140 chars) — opponents read it too.
`;

  const chat: Chat = { summary: "game just started" };
  const start = Date.now();
  let turns = 0;

  for (;;) {
    // ---- wait for my turn (long-poll, retry until it's mine) ----
    let myTurn = false;
    while (turns <= MAX_TURNS && Date.now() - start < 25 * 60_000) {
      const w = await mcp.tool("risk_wait_for_turn", { max_wait_s: 25 });
      if (w.game_over) break;
      if (w.your_turn) {
        myTurn = true;
        break;
      }
      await sleep(1500);
    }
    const status0 = await mcp.tool("risk_status");
    if (status0.status === "over") break;
    if (!myTurn) break; // hit the safety cap

    // ---- play the turn with the LLM ----
    turns++;
    const msgs: Msg[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Turn ${turns}. ${chat.summary}\nCurrent full state (JSON):\n${JSON.stringify(status0, null, 0)}\nPlay your turn now with tools.`,
      },
    ];

    let ended = false;
    let noToolStreak = 0;
    let n = 0;
    while (n < MAX_ACTIONS_PER_TURN && !ended) {
      n++;
      const out = await llm(tools, msgs);
      msgs.push(out);
      if (!out.tool_calls || out.tool_calls.length === 0) {
        noToolStreak++;
        if (out.content) console.log(`  [${AGENT_NAME}] ${out.content.slice(0, 140)}`);
        if (noToolStreak >= 3) {
          console.log("  ⚠ LLM refused to use tools — ending turn");
          break;
        }
        msgs.push({ role: "user", content: "Act with a tool now (you cannot type moves in chat)." });
        continue;
      }
      noToolStreak = 0;
      for (const tc of out.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        process.stdout.write(`  → ${tc.function.name}(${tc.function.arguments.slice(0, 80)})`);
        const t0 = Date.now();
        const result = await mcp.tool(tc.function.name, args).catch((e) => ({ ok: false, error: e.message }));
        console.log(` ok=${result.ok ?? "?"} ${Date.now() - t0}ms`);
        if (tc.function.name === "risk_end_turn" || tc.function.name === "risk_resign") ended = true;
        msgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result, null, 0) });
        if (result.status === "over") {
          ended = true;
          break;
        }
      }
      await sleep(250); // be gentle on the free tier
    }

    if (ended) break;
    // forced: the LLM never called end_turn within the cap
    const mid = await mcp.tool("risk_status");
    if (mid.status === "running" && mid.yourTurn) {
      console.log("  ⚠ action cap reached — forcing end_turn");
      await mcp.tool("risk_end_turn");
    }

    // ---- compact: rebuild the rolling summary from the live state ----
    const st = await mcp.tool("risk_status");
    const me = st.board.filter((b: any) => b.your).reduce((a: number, b: any) => a + b.armies, 0);
    const terrs = st.board.filter((b: any) => b.your).length;
    chat.summary = `You own ${terrs} territories, ${me} armies. ${st.winner ? "" : `Turn ${turns} done.`}`;
    if (st.status === "over") break;
  }

  // ---- final result (REST has winReason; MCP status is LLM-shaped) ----
  const fin = await fetch(`${BASE}/api/rooms/${gameId}`).then((r) => r.json() as Promise<any>);
  const fs = fin.state;
  const mins = ((Date.now() - start) / 60_000).toFixed(1);
  const winnerName = fs.players.find((p: any) => p.id === fs.winner)?.name ?? fs.winner ?? "?";
  const youWon = fs.winner === "p1";
  console.log(`\n=== GAME OVER in ${mins} min (${turns} agent turns) ===`);
  console.log(`winner: ${winnerName} — ${fs.winReason ?? "?"}${youWon ? "  🏆 OUR LLM WON" : ""}`);
  const reps = fin.reports ?? [];
  console.log("final standings:");
  for (const r of reps) console.log(`  ${r.name}: ${r.territories} terr, ${r.armies} armies${r.alive ? "" : " (eliminated)"}`);
  console.log("final feed (last 12):");
  for (const l of fs.feed.slice(-12)) console.log(`  t${l.turn} ${l.text}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("LLM-AGENT FAILED:", e.message);
  process.exit(1);
});
