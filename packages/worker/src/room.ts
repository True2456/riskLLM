import { Game, type GameConfig, type GameState, type Move, type PlayerSpec } from "@riskllm/engine";
import { verifyToken } from "./token";

interface RoomMeta {
  createdAt: number;
  recorded?: boolean;
}

/**
 * One Durable Object per war room. Owns the authoritative Game instance.
 * Humans talk over WebSocket; agents talk via the /mcp route (which
 * dispatchFetches JSON ops to this object); both see the same state.
 */
export class GameRoom {
  private game: Game | null = null;
  private meta: RoomMeta = { createdAt: 0 };

  constructor(private state: DurableObjectState, private env: Env) {}

  /** Per-connection state that survives hibernation (serializeAttachment, ≤16 KB). */
  private ownerOf(ws: WebSocket): string | null {
    const att = ws.deserializeAttachment() as { owner: string | null } | null;
    return att?.owner ?? null;
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    if (this.game) return;
    const raw = await this.state.storage.get<string>("game");
    if (raw) {
      this.game = Game.fromState(JSON.parse(raw) as GameState);
      const meta = (await this.state.storage.get<string>("meta")) as string | undefined;
      if (meta) this.meta = JSON.parse(meta) as RoomMeta;
    }
  }

  private async persist() {
    if (!this.game) return;
    await this.state.storage.put("game", JSON.stringify(this.game.state));
    await this.state.storage.put("meta", JSON.stringify(this.meta));
  }

  private now(): number {
    return Date.now();
  }

  // ------------------------------------------------------------- sockets

  private broadcast() {
    if (!this.game) return;
    const payload = JSON.stringify({ t: "state", state: this.game.state });
    // getWebSockets() is the hibernation-safe source of truth for live clients:
    // connections accepted via state.acceptWebSocket() persist across hibernation,
    // so the in-memory socket set would go stale after the DO sleeps & wakes.
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* dropped */
      }
    }
  }

  // ------------------------------------------------------- tick/alarm loop

  /**
   * Advance bots / deadline-auto-play, persist, broadcast, and re-arm the
   * alarm for the next deadline. Cheap to call from any entry point.
   *
   * Note: when the game ENDS we deliberately do NOT re-arm the alarm. The room
   * then hibernates (zero duration billing, zero DO requests) and rehydrates
   * from SQLite on demand when anyone opens the share link or fetches the
   * trace. Result recording happens in the worker's /api/rooms list (idempotent
   * in the board), so finished games still show up without a keep-alive loop.
   * (A forever-re-arming keepalive would drain the DO free-tier request quota.)
   */
  private async step(): Promise<void> {
    if (!this.game) return;
    const before = this.game.state.nextSeq;
    if (this.game.state.status === "running") this.game.tick(this.now());
    if (this.game.state.nextSeq !== before) await this.persist();
    this.broadcast();
    if (this.game.state.status === "running" && this.game.state.turnOwner) {
      await this.state.storage.setAlarm(this.game.state.deadlineMs);
    }
  }

  // --------------------------------------------------------------- fetch

  async fetch(request: Request): Promise<Response> {
    await this.init();

    if (request.headers.get("upgrade") === "websocket") {
      return this.handleSocket(request);
    }

    if (request.method === "POST") {
      try {
        const op = (await request.json()) as {
          op: string;
          cfg?: GameConfig;
          playerId?: string;
          move?: Move;
        };
        if (op.op === "create") {
          if (this.game || !op.cfg) return json({ error: "room exists" }, 409);
          const game = new Game({ ...op.cfg, now: this.now() });
          this.game = game;
          this.meta = { createdAt: this.now() };
          await this.persist();
          this.broadcast();
          await this.step();
          return json({ ok: true });
        }
        return await this.handleOp(op);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    return json({ error: "not found" }, 404);
  }

  /** Durable Object alarm entry point. */
  async alarm(): Promise<void> {
    await this.init();
    await this.step();
  }

  /**
   * Apply a move with full error surfacing: on rejection, push a feed line so
   * every connected client (humans + MCP) sees what went wrong. Shared by the
   * WS path and the MCP dispatch path (per PROTOCOL.md §2).
   */
  private async applyMove(playerId: string, move: Move): Promise<{ ok: boolean; error?: string }> {
    if (!this.game) return { ok: false, error: "no such room" };
    const res = this.game.apply(playerId, move, this.now());
    if (!res.ok) {
      const p = this.game.state.players.find((x) => x.id === playerId);
      this.game.state.feed.push({
        seq: this.game.state.nextSeq++,
        turn: this.game.state.turn,
        playerId,
        kind: "game",
        text: `⚠ ${p?.name ?? playerId}: ${res.error}`,
        ts: this.now(),
      });
    }
    await this.step();
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  private async handleOp(op: { op: string; playerId?: string; move?: Move }): Promise<Response> {
    if (!this.game) return json({ error: "no such room" }, 404);
    const s = this.game.state;
    switch (op.op) {
      case "state":
        return json({ state: s, reports: this.game.reports() });
      case "lobby":
        return json({
          gameId: s.game,
          mode: s.mode,
          status: s.status,
          turn: s.turn,
          phase: s.phase,
          winner: s.winner,
          createdAt: this.meta.createdAt,
          players: this.game.reports().map((r) => ({
            name: r.name,
            kind: r.kind,
            color: r.color,
            territories: r.territories,
            armies: r.armies,
            alive: r.alive,
          })),
        });
      case "apply": {
        if (!op.playerId || !op.move) return json({ error: "missing" }, 400);
        const res = await this.applyMove(op.playerId, op.move);
        return json(
          res.ok ? { ok: true, state: this.game.state } : { ok: false, error: res.error, state: this.game.state },
          res.ok ? 200 : 409,
        );
      }
      case "tick":
        await this.step();
        return json({ ok: true, state: this.game.state });
      case "reports":
        return json({ reports: this.game.reports() });
      default:
        return json({ error: "unknown op" }, 400);
    }
  }

  // ------------------------------------------------------------- websocket

  private async handleSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const gameId = url.searchParams.get("gameId") ?? url.pathname.split("/").pop() ?? "";
    let you: string | null = null;
    if (token && token !== "spectate") {
      const secret = this.env.MCP_SECRET ?? "dev";
      const check = await verifyToken(token, secret);
      you = check && check.gameId === gameId ? check.playerId : null;
    }
    if (you) {
      const p = this.game?.state.players.find((p) => p.id === you);
      if (p) p.lastSeenMs = this.now();
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation-safe accept: unlike server.accept(), this lets the DO sleep
    // (no duration billing) while clients stay connected; a message/alarm wakes
    // it and init() rehydrates the game from SQLite. Per-connection owner is
    // carried in a serialized attachment so it survives the hibernation.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ owner: you } as { owner: string | null });
    server.send(JSON.stringify({ t: "joined", you }));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation WebSocket handler — the DO wakes here on a client message. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const msg = JSON.parse(String(message)) as { t?: string; move?: Move };
      if (msg.t === "ping") {
        ws.send(JSON.stringify({ t: "pong" }));
        return;
      }
      const owner = this.ownerOf(ws);
      if (msg.t === "move" && msg.move && owner && this.game) {
        await this.applyMove(owner, msg.move);
      }
    } catch {
      /* ignore malformed frames */
    }
  }

  /** Connection went away; the runtime already removed it from getWebSockets(). */
  async webSocketClose(): Promise<void> {}
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
