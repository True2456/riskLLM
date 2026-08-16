import { ADJACENCY, TERRITORY_BY_ID, type GameState, type Move } from "@riskllm/engine";
import { Pool, type LlmMsg, type Strategy } from "@riskllm/llm";

interface BoardViewRow {
  id: string;
  name: string;
  owner: string | null;
  armies: number;
  yours: boolean;
  adjacent: string[];
}

// Same LLM-facing board formatting the /mcp risk_status uses.
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

/**
 * The League: an always-on Durable Object that keeps real-LLM battles running
 * 24/7. It is the "headless" version of scripts/llm-agent.ts — instead of a
 * single local process that exits, it is a stateful, alarm-driven loop that:
 *
 *   1. fields a "featured battle" (a room with several LLM seats, each on a
 *      different provider from the pool: auto / free / ling) plus house bots;
 *   2. on every alarm (~20s), for each LLM seat whose turn it is, makes one LLM
 *      decision and applies it to the room (the same apply path humans/MCP use);
 *   3. accumulates each seat's full CoT + tool trace (persisted, survives
 *      hibernation);
 *   4. when a battle ends, publishes the WINNER's trace to the board (so the
 *      lobby offers a download), records the result, and starts the next battle
 *      — so there is always a game going.
 *
 * It rides out free-tier rate limits: when every provider is 429'd, a seat
 * simply doesn't act that cycle and the room's deadline autopilot covers it;
 * the next cycle retries. So the battle is "best-effort real LLM" that never
 * stalls and never crashes.
 */

interface LeagueSeat {
  gameId: string;
  seatId: string;
  agentName: string;
  provider: Strategy;
  /** rolling one-line state summary (rebuilt at each turn boundary) */
  summary: string;
  /** accumulated JSONL trace lines for this seat's LLM brain */
  trace: string;
  turns: number;
  addedAt: number;
}

const ALARM_MS = 20_000;
const MAX_ACTIONS_PER_CYCLE = 2; // LLM decisions per seat per alarm (keep latency bounded)

// The 12 tools, compact schemas (same surface as /mcp). The LLM only needs to
// call these; territory args accept id or name.
const TOOLS: unknown[] = [
  { type: "function", function: { name: "risk_status", description: "Read the full board, your armies/cards, whose turn it is, and the timer.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_wait_for_turn", description: "Wait until it is your turn.", parameters: { type: "object", properties: { max_wait_s: { type: "number" } } } } },
  { type: "function", function: { name: "risk_deploy", description: "Reinforce: place armies on a territory you own.", parameters: { type: "object", properties: { territory: { type: "string" }, n: { type: "number" } }, required: ["territory"] } } },
  { type: "function", function: { name: "risk_trade_cards", description: "Trade 3 cards for 5 armies.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_end_reinforce", description: "Finish deploying; start combat.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_attack", description: "Attack an adjacent enemy territory.", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dice: { type: "number", minimum: 1, maximum: 3 } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "risk_move", description: "Combat phase: shift armies to an adjacent territory you own.", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, n: { type: "number" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "risk_pass_combat", description: "Stop attacking; go to fortify.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_fortify", description: "Fortify: move armies along your own empire.", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, n: { type: "number" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "risk_end_turn", description: "End your turn.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_resign", description: "Surrender.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "risk_chat", description: "Broadcast a short message (<=140 chars). Everyone reads it.", parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } } },
];

const SYSTEM = `You are an AI commanding a country in a live game of Risk (RiskLLM).
You act ONLY by calling a tool. Territory args accept the id (e.g. "ALA") or the name (e.g. "Alaska").
Strategy: consolidate one continent early; attack 1-army tiles with 2 dice, 2-army tiles with 3; keep 1 army in any tile you attack from; fortify to keep borders strong; trade cards when you hold 3. End your turn with risk_end_turn. If hopeless, risk_resign. You may risk_chat (short) — opponents read it too.`;

export class League {
  private seats: LeagueSeat[] = [];
  private ready = false;

  constructor(private state: DurableObjectState, private env: Env) {}

  private get pool(): Pool {
    return new Pool({ key: this.env.OPENROUTER_KEY ?? "", referer: this.env.SITE_URL ?? "https://riskllm.true2456.workers.dev", title: "riskllm-league" });
  }

  private async ensure() {
    if (this.ready) return;
    const raw = await this.state.storage.get<string>("seats");
    this.seats = raw ? (JSON.parse(raw) as LeagueSeat[]) : [];
    this.ready = true;
  }

  private async persistSeats() {
    await this.state.storage.put("seats", JSON.stringify(this.seats));
  }

  // ------------------------------------------------------------- room ops

  private async roomState(gameId: string): Promise<GameState | null> {
    const stub = this.env.GAME.get(this.env.GAME.idFromName(gameId));
    const res = await stub.fetch(`http://internal/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "state" }) });
    if (res.status === 404) return null;
    const data = (await res.json().catch(() => null)) as { state?: GameState } | null;
    return data?.state ?? null;
  }

  private async applyToRoom(gameId: string, seatId: string, move: Move): Promise<{ ok: boolean; error?: string; state?: GameState }> {
    const stub = this.env.GAME.get(this.env.GAME.idFromName(gameId));
    const res = await stub.fetch(`http://internal/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "apply", playerId: seatId, move }) });
    return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string; state?: GameState };
  }

  private async createRoom(seats: { kind: string; name: string; provider?: Strategy }[]): Promise<string | null> {
    const gameId = Math.random().toString(36).slice(2, 10);
    const players = seats.map((s, i) => ({
      id: `p${i + 1}`,
      name: s.name,
      kind: (s.kind === "agent" ? "agent" : "bot") as "agent" | "bot",
      botStyle: s.kind === "bot" ? ("balanced" as const) : undefined,
    }));
    const cfg = { gameId, mode: "blitz" as const, players };
    const stub = this.env.GAME.get(this.env.GAME.idFromName(gameId));
    const res = await stub.fetch(`http://internal/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create", cfg }) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!data.ok) return null;
    return gameId;
  }

  // ---------------------------------------------------------- battle lifecycle

  async startBattle(): Promise<{ gameId: string; players: { name: string; provider?: string }[] }> {
    await this.ensure();
    // A featured battle: 3 LLM seats on different providers + 1 house bot.
    const lineup: { kind: string; name: string; provider?: Strategy }[] = [
      { kind: "agent", name: "Auto", provider: "auto" },
      { kind: "agent", name: "Free", provider: "free" },
      { kind: "agent", name: "Ling", provider: "ling" },
      { kind: "bot", name: "Warmonger" },
    ];
    const gameId = await this.createRoom(lineup);
    if (!gameId) throw new Error("failed to create league room");
    // register on the board so it shows in the lobby
    await this.env.BOARD.get(this.env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "register", gameId, mode: "blitz", status: "running" }),
    }).catch(() => {});
    this.seats = lineup
      .filter((s) => s.kind === "agent")
      .map((s, i) => ({
        gameId,
        seatId: `p${i + 1}`,
        agentName: s.name,
        provider: s.provider ?? "auto",
        summary: "game just started",
        trace: "",
        turns: 0,
        addedAt: Date.now(),
      }));
    await this.persistSeats();
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
    return { gameId, players: lineup.map((s) => ({ name: s.name, provider: s.provider })) };
  }

  async status() {
    await this.ensure();
    const active = this.seats.length > 0;
    const out: { gameId: string; seats: { name: string; provider: string; turns: number }[] }[] = [];
    if (active) {
      const gameId = this.seats[0].gameId;
      out.push({ gameId, seats: this.seats.map((s) => ({ name: s.agentName, provider: s.provider, turns: s.turns })) });
    }
    return { active, battles: out, pool: this.pool.status() };
  }

  // ------------------------------------------------------------- driver loop

  async alarm(): Promise<void> {
    await this.ensure();
    if (this.seats.length === 0) return; // nothing running; a startBattle() will arm us
    const gameId = this.seats[0].gameId;
    const roomState = await this.roomState(gameId);
    if (!roomState) {
      this.seats = [];
      await this.persistSeats();
      return;
    }
    if (roomState.status === "over") {
      await this.onGameOver(roomState);
      // auto-start the next battle so there's always a game going
      try {
        await this.startBattle();
      } catch {
        /* no key / transient — retry next cycle */
      }
      return;
    }
    // drive each LLM seat whose turn it is (one seat per cycle to bound latency)
    for (const seat of this.seats) {
      if (roomState.turnOwner !== seat.seatId) continue;
      let acted = 0;
      for (let i = 0; i < MAX_ACTIONS_PER_CYCLE; i++) {
        const st = await this.roomState(gameId);
        if (!st || st.status === "over" || st.turnOwner !== seat.seatId) break;
        const didAct = await this.driveSeat(seat, st);
        if (!didAct) break; // rate-limited everywhere or no tool call — autopilot covers
        acted++;
      }
      if (acted > 0) await this.persistSeats();
    }
    // re-arm
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
  }

  /** One LLM decision for a seat: call the pool, apply the tool, record trace. */
  private async driveSeat(seat: LeagueSeat, st: GameState): Promise<boolean> {
    if (!this.env.OPENROUTER_KEY) return false;
    const me = st.players.find((p) => p.id === seat.seatId);
    if (!me || me.eliminated) return false;
    const msgs: LlmMsg[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Turn ${st.turn}. ${seat.summary}\nCurrent full state (JSON):\n${JSON.stringify(this.llmView(st, seat.seatId))}\nPlay your next action with a tool now.` },
    ];
    let out: LlmMsg;
    try {
      const res = await this.pool.call(TOOLS, msgs, seat.provider);
      out = res.message;
      if (!out.tool_calls || out.tool_calls.length === 0) {
        // the model talked instead of acting — nudge it (recorded in trace)
        this.appendTrace(seat, st.turn, msgs, out, res.provider.label, res.routedModel);
        msgs.push(out);
        msgs.push({ role: "user", content: "Act with a tool now (you cannot type moves in chat)." });
        return false;
      }
    } catch {
      return false; // every provider 429/403 — autopilot covers; retry next cycle
    }
    const tc = out.tool_calls[0];
    const move = this.toolToMove(tc.function.name, tc.function.arguments);
    this.appendTrace(seat, st.turn, msgs, out, this.poolStatusLabel(seat.provider), tc.function.name);
    if (!move) return false; // status/wait/chat-only or unknown — no state change
    const res = await this.applyToRoom(seat.gameId, seat.seatId, move);
    // rebuild the rolling summary at the turn boundary (or after acting)
    seat.summary = this.rebuildSummary(st, seat.seatId);
    if (move.t === "end_turn" || move.t === "resign") seat.turns++;
    void res;
    return true;
  }

  private poolStatusLabel(p: Strategy): string {
    return p;
  }

  /** Record one prompt->completion trace line (chat format, for LLM training). */
  private appendTrace(seat: LeagueSeat, turn: number, context: LlmMsg[], completion: LlmMsg, providerLabel: string, routedModel?: string) {
    const line = JSON.stringify({
      game: seat.gameId,
      agent: seat.agentName,
      model: routedModel ?? providerLabel,
      provider: providerLabel,
      turn,
      messages: context,
      completion,
    });
    seat.trace = (seat.trace ? seat.trace + "\n" : "") + line;
    // cap trace size (a full game is a few hundred KB; keep it bounded)
    if (seat.trace.length > 2_000_000) seat.trace = seat.trace.slice(-2_000_000);
  }

  private rebuildSummary(st: GameState, seatId: string): string {
    const owned = Object.values(st.territories).filter((t) => t.owner === seatId);
    const terrs = owned.length;
    const armies = owned.reduce((a, t) => a + t.armies, 0);
    return `You own ${terrs} territories, ${armies} armies.`;
  }

  /** A compact, LLM-friendly view of the state (same shape as /mcp risk_status). */
  private llmView(st: GameState, seatId: string) {
    const me = st.players.find((p) => p.id === seatId);
    const owner = st.turnOwner ? st.players.find((p) => p.id === st.turnOwner) : null;
    return {
      game: st.game,
      mode: st.mode,
      status: st.status,
      turn: st.turn,
      phase: st.phase,
      turnOwner: owner?.name ?? null,
      yourTurn: st.turnOwner === seatId,
      toReinforce: st.toReinforce,
      fortifyMovesLeft: st.fortifyMoves,
      yourCards: me?.cards ?? [],
      winner: st.winner ? st.players.find((p) => p.id === st.winner)?.name : null,
      winReason: st.winReason,
      board: boardView(st, seatId),
    };
  }

  /** Map an LLM tool call to an engine Move (read-only tools -> null). */
  private toolToMove(name: string, argsJson: string): Move | null {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      return null;
    }
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const num = (k: string, d: number) => (typeof args[k] === "number" ? (args[k] as number) : d);
    switch (name) {
      case "risk_deploy":
        return { t: "deploy", territory: str("territory") ?? "", n: num("n", 1) };
      case "risk_trade_cards":
        return { t: "trade_cards" };
      case "risk_end_reinforce":
        return { t: "end_reinforce" };
      case "risk_attack":
        return { t: "attack", from: str("from") ?? "", to: str("to") ?? "", dice: Math.min(3, Math.max(1, num("dice", 1))) };
      case "risk_move":
        return { t: "move", from: str("from") ?? "", to: str("to") ?? "", n: num("n", 1) };
      case "risk_pass_combat":
        return { t: "pass_combat" };
      case "risk_fortify":
        return { t: "fortify", from: str("from") ?? "", to: str("to") ?? "", n: num("n", 1) };
      case "risk_end_turn":
        return { t: "end_turn" };
      case "risk_resign":
        return { t: "resign" };
      case "risk_chat":
        return { t: "chat", msg: (str("msg") ?? "").slice(0, 140) };
      default:
        return null; // risk_status / risk_wait_for_turn — read-only, no move
    }
  }

  private async onGameOver(st: GameState): Promise<void> {
    const winnerId = st.winner;
    const winnerName = st.players.find((p) => p.id === winnerId)?.name ?? winnerId ?? null;
    // record on the board (idempotent — the /api/rooms poller does this too)
    await this.env.BOARD.get(this.env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "recordResult",
        gameId: st.game,
        mode: st.mode,
        winner: winnerId,
        winnerName,
        turns: st.turn,
        players: st.players.map((p) => p.name),
      }),
    }).catch(() => {});
    // publish the winner's trace (only if the winner is one of our LLM seats)
    const winnerSeat = this.seats.find((s) => s.seatId === winnerId && s.trace);
    if (winnerSeat && winnerSeat.trace) {
      await this.env.BOARD.get(this.env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "uploadTrace",
          gameId: st.game,
          seatId: winnerSeat.seatId,
          agentName: winnerSeat.agentName,
          model: "league",
          content: winnerSeat.trace,
          lines: winnerSeat.trace.split("\n").filter(Boolean).length,
        }),
      }).catch(() => {});
    }
    this.seats = [];
    await this.persistSeats();
  }

  // --------------------------------------------------------------- HTTP face

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { op?: string };
    if (body.op === "start") {
      try {
        const r = await this.startBattle();
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }
    if (body.op === "status") {
      return json(await this.status());
    }
    return json({ error: "unknown op" }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
