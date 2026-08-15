import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  TERRITORY_BY_ID,
  ADJACENCY,
  type GameState,
  type Move,
  type PlayerReport,
} from "@riskllm/engine";

// Real LLMs pass display names ("Alaska") as often as ids ("ALA").
// Normalize both case-insensitively to the canonical id before the engine sees it.
const ID_BY_NAME = new Map<string, string>(
  Object.entries(TERRITORY_BY_ID).map(([id, t]) => [t.name.toLowerCase(), id]),
);
const ID_SET = new Set<string>(Object.keys(TERRITORY_BY_ID));
export function resolveTerr(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const up = input.trim().toUpperCase();
  if (ID_SET.has(up)) return up;
  return ID_BY_NAME.get(input.trim().toLowerCase()) ?? null;
}

export interface RoomDispatch {
  (op: "state" | "apply" | "tick", playerId?: string, move?: Move): Promise<{
    state: GameState;
    reports?: PlayerReport[];
    ok?: boolean;
    error?: string;
  }>;
}

const RULES = `RISKLLM RULES (6 lines):
- 42 territories on a world map. You command ONE side (army of army tokens).
- Each turn, in order: REINFORCE (deploy new armies, optionally trade 3 cards for 5), COMBAT (attack/move, as many actions as you like), FORTIFY (move armies along your own empire, max 3), then end_turn.
- Attack: you roll up to 3 dice, defender rolls up to 2; highest vs highest, then next, defender wins ties. Attacker must keep 1 army; on capture you push armies in.
- Good attacks: 2 dice vs a 1-army tile (locked win over time), 3 dice vs a 2-army tile. Never attack 3+ armies with fewer than 3 dice.
- Win: hold 35-60% of all armies (by player count), eliminate everyone, or lead at sudden death (blitz, turn 15).
- You may send brief messages with risk_chat (allies read them; opponents read them too).`;

interface BoardViewRow {
  id: string;
  name: string;
  owner: string | null;
  armies: number;
  yours: boolean;
  adjacent: string[];
}

function boardView(state: GameState, me: string): BoardViewRow[] {
  const owners = new Map<string, string>();
  for (const p of state.players) owners.set(p.id, p.name);
  return Object.entries(state.territories).map(([id, t]) => {
    const adjacent = ADJACENCY[id].map((nb) => {
      const o = state.territories[nb];
      return o.owner === me ? `${nb}` : o.owner ? `${nb}(${owners.get(o.owner)!}:${o.armies})` : nb;
    });
    return {
      id,
      name: TERRITORY_BY_ID[id].name,
      owner: t.owner ? owners.get(t.owner) ?? t.owner : null,
      armies: t.armies,
      yours: t.owner === me,
      adjacent,
    };
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a fresh stateless MCP server bound to one seat of one room.
 * Served per-request over Streamable HTTP (JSON responses).
 */
export async function handleMcpRequest(request: Request, gameId: string, playerId: string, dispatch: RoomDispatch): Promise<Response> {
  const server = new McpServer({ name: "riskllm", version: "0.1.0" });

  const common = {
    title: "RiskLLM",
  };

  const stateAnd = async (extra?: Record<string, unknown>) => {
    const r = await dispatch("state");
    const s = r.state;
    const me = s.players.find((p) => p.id === playerId)!;
    const owner = s.turnOwner ? s.players.find((p) => p.id === s.turnOwner) : null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              game: s.game,
              mode: s.mode,
              status: s.status,
              turn: s.turn,
              phase: s.phase,
              turnOwner: owner?.name ?? null,
              yourTurn: s.turnOwner === playerId,
              yourTimeLeftS: s.turnOwner === playerId ? Math.max(0, Math.round((s.deadlineMs - Date.now()) / 1000)) : null,
              toReinforce: s.toReinforce,
              fortifyMovesLeft: s.fortifyMoves,
              yourCards: me.cards,
              winner: s.winner ? s.players.find((p) => p.id === s.winner)?.name : null,
              winReason: s.winReason,
              board: boardView(s, playerId),
              last_feed: s.feed.slice(-15).map((l) => l.text),
              ...(extra ?? {}),
            },
            null,
            0,
          ),
        },
      ],
    };
  };

  const applyAnd = async (move: Move, note?: string) => {
    const r = await dispatch("apply", playerId, move);
    const s = r.state;
    const me = s.players.find((p) => p.id === playerId)!;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: r.ok ?? true,
              error: r.error,
              note,
              turn: s.turn,
              phase: s.phase,
              yourTurn: s.turnOwner === playerId,
              toReinforce: s.toReinforce,
              fortifyMovesLeft: s.fortifyMoves,
              yourCards: me.cards,
              winner: s.winner ? s.players.find((p) => p.id === s.winner)?.name : null,
              last_feed: s.feed.slice(-5).map((l) => l.text),
              board: boardView(s, playerId),
            },
            null,
            0,
          ),
        },
      ],
    };
  };

  const applyErr = (error: string) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error }),
      },
    ],
  });

  server.registerTool("risk_status", {
    title: common.title,
    description: `Full overview of your RiskLLM war. ${RULES}`,
    inputSchema: {},
  }, async () => stateAnd());

  server.registerTool("risk_wait_for_turn", {
    description: "Block until it is your turn (up to max_wait_s). If it is not your turn in time, call again. This is your main loop: wait → read state → act → wait.",
    inputSchema: { max_wait_s: z.number().min(1).max(25).optional() },
  }, async (args: { max_wait_s?: number }) => {
    const cap = Math.min(25, Math.max(1, Number(args.max_wait_s ?? 25)));
    const start = Date.now();
    for (;;) {
      const r = await dispatch("state");
      const s = r.state;
      if (s.status === "over") {
        const w = s.winner ? s.players.find((p) => p.id === s.winner)?.name : null;
        return { content: [{ type: "text" as const, text: JSON.stringify({ game_over: true, winner: w, reason: s.winReason }) }] };
      }
      if (s.turnOwner === playerId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ your_turn: true, phase: s.phase, turn: s.turn, toReinforce: s.toReinforce }) }] };
      }
      if (Date.now() - start > cap * 1000) {
        const owner = s.turnOwner ? s.players.find((p) => p.id === s.turnOwner)?.name : null;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ waiting: true, retry_after_s: 20, phase: s.phase, turn: s.turn, turnOwner: owner }),
            },
          ],
        };
      }
      await sleep(2000);
    }
  });

  server.registerTool("risk_deploy", {
    description: "Reinforce phase: place up to your `toReinforce` armies on a territory you own.",
    inputSchema: { territory: z.string(), n: z.number().int().min(1).optional() },
  }, async (args) => {
    const territory = resolveTerr(args.territory);
    if (!territory) return applyErr(`unknown territory ${args.territory}`);
    return applyAnd({ t: "deploy", territory, n: args.n ?? 1 });
  });

  server.registerTool("risk_trade_cards", {
    description: "Reinforce phase: trade 3 cards for 5 armies (you need 3 cards).",
    inputSchema: {},
  }, async () => applyAnd({ t: "trade_cards" }));

  server.registerTool("risk_end_reinforce", {
    description: "Reinforce phase: finish deploying (undeployed armies are lost) and start combat.",
    inputSchema: {},
  }, async () => applyAnd({ t: "end_reinforce" }));

  server.registerTool("risk_attack", {
    description: "Combat phase: attack an adjacent enemy territory. Default dice = max allowed. You must keep 1 army in the source territory.",
    inputSchema: { from: z.string(), to: z.string(), dice: z.number().int().min(1).max(3).optional() },
  }, async (args) => {
    const from = resolveTerr(args.from);
    const to = resolveTerr(args.to);
    if (!from || !to) return applyErr(`unknown territory (${args.from} -> ${args.to})`);
    const r = await dispatch("state");
    const maxDice = Math.min(3, (r.state.territories[from]?.armies ?? 2) - 1);
    const d = args.dice ?? Math.max(1, maxDice);
    return applyAnd({ t: "attack", from, to, dice: d });
  });

  server.registerTool("risk_move", {
    description: "Combat phase: move armies to an adjacent territory you already own.",
    inputSchema: { from: z.string(), to: z.string(), n: z.number().int().min(1).optional() },
  }, async (args) => {
    const from = resolveTerr(args.from);
    const to = resolveTerr(args.to);
    if (!from || !to) return applyErr(`unknown territory (${args.from} -> ${args.to})`);
    return applyAnd({ t: "move", from, to, n: args.n });
  });

  server.registerTool("risk_pass_combat", {
    description: "Combat phase: stop attacking and go to the fortify phase (3 moves).",
    inputSchema: {},
  }, async () => applyAnd({ t: "pass_combat" }));

  server.registerTool("risk_fortify", {
    description: "Fortify phase: move armies from one of your territories to another along your own empire (any connected path). Max 3 per turn.",
    inputSchema: { from: z.string(), to: z.string(), n: z.number().int().min(1).optional() },
  }, async (args) => {
    const from = resolveTerr(args.from);
    const to = resolveTerr(args.to);
    if (!from || !to) return applyErr(`unknown territory (${args.from} -> ${args.to})`);
    return applyAnd({ t: "fortify", from, to, n: args.n });
  });

  server.registerTool("risk_end_turn", {
    description: "Finish your turn (goes combat→fortify if you skipped fortify, or ends the turn from fortify). You receive a card if you conquered this turn.",
    inputSchema: {},
  }, async () => applyAnd({ t: "end_turn" }));

  server.registerTool("risk_resign", {
    description: "Surrender the war. Use only if the position is hopeless.",
    inputSchema: {},
  }, async () => applyAnd({ t: "resign" }));

  server.registerTool("risk_chat", {
    description: "Send a short message (max 140 chars) to the shared war feed. Everyone can read it, allies or not.",
    inputSchema: { msg: z.string().max(140) },
  }, async (args) => applyAnd({ t: "chat", msg: args.msg }));

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
