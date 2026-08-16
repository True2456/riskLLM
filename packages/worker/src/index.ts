/// <reference types="@cloudflare/workers-types" />
import { MODES, type BotStyle, type ModeId, type Move, type PlayerKind } from "@riskllm/engine";
import { handleMcpRequest } from "./mcp";
import { makeToken, verifyToken, bearer } from "./token";
import { GameRoom } from "./room";
import { Board } from "./board";
import { League } from "./league";

// Durable Object classes (referenced by wrangler.toml)
export { GameRoom, Board, League };

const BOT_STYLES: BotStyle[] = ["aggressive", "balanced", "turtle"];
const KINDS: PlayerKind[] = ["human", "agent", "bot"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function randomGameId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

async function roomOp(
  env: Env,
  gameId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any } | null> {
  const stub = env.GAME.get(env.GAME.idFromName(gameId));
  const res = await stub.fetch(`http://internal/${body.op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 404) return null;
  return { status: res.status, body: data };
}

// --------------------------------------------------------------------- API

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const secret = env.MCP_SECRET || "dev";

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true });
  }

  // The always-on LLM league: status + start-a-battle.
  if (path === "/api/league" && request.method === "GET") {
    const res = await env.LEAGUE.get(env.LEAGUE.idFromName("main")).fetch(`http://internal/league`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "status" }),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  }
  if (path === "/api/league/start" && request.method === "POST") {
    const res = await env.LEAGUE.get(env.LEAGUE.idFromName("main")).fetch(`http://internal/league`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "start" }),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  }

  if (path === "/api/rooms" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      mode?: ModeId;
      seats?: { kind?: string; name?: string; botStyle?: string }[];
    };
    const mode = (body.mode ?? "blitz") as ModeId;
    const spec = MODES[mode];
    if (!spec) return json({ error: `unknown mode ${mode}` }, 400);
    const seats = body.seats;
    if (!Array.isArray(seats) || seats.length < spec.players[0] || seats.length > spec.players[1]) {
      return json({ error: `${mode} takes ${spec.players[0]}–${spec.players[1]} seats` }, 400);
    }
    if (seats.filter((s) => s.kind === "human").length > 1) {
      return json({ error: "at most one human seat (the creator)" }, 400);
    }
    const players = seats.map((s, i) => {
      const kind = (KINDS.includes(s.kind as PlayerKind) ? s.kind : "bot") as PlayerKind;
      const botStyle = (BOT_STYLES.includes(s.botStyle as BotStyle) ? s.botStyle : "balanced") as BotStyle;
      const name =
        (s.name ?? "").slice(0, 32) ||
        (kind === "human" ? "You" : kind === "agent" ? `Agent ${i + 1}` : `Bot ${i + 1}`);
      return { id: `p${i + 1}`, name, kind, botStyle: kind === "bot" ? botStyle : undefined };
    });
    const gameId = randomGameId();
    const cfg = { gameId, mode, players };
    const created = await roomOp(env, gameId, { op: "create", cfg });
    if (!created) return json({ error: "room creation failed" }, 500);
    const boardRes = await env.BOARD.get(env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "register", gameId, mode, status: "running" }),
    });
    await boardRes.json().catch(() => null);
    const tokens: Record<string, string> = {};
    for (const p of players) {
      if (p.kind === "human" || p.kind === "agent") tokens[p.id] = await makeToken(gameId, p.id, secret);
    }
    return json(
      {
        gameId,
        url: `/r/${gameId}`,
        spectateUrl: `/game/${gameId}`,
        tokens,
        players: players.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      },
      201,
    );
  }

  if (path === "/api/rooms" && request.method === "GET") {
    const board = env.BOARD.get(env.BOARD.idFromName("main"));
    const listed = await board.fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "listRooms", limit: 12 }),
    });
    const { rooms } = (await listed.json().catch(() => ({ rooms: [] }))) as { rooms: { gameId: string }[] };
    const detailed = await Promise.all(
      rooms.map(async (r) => {
        const res = await roomOp(env, r.gameId, { op: "lobby" });
        const body = res?.body ?? null;
        // Record finished games on the board as the list is polled (idempotent
        // in the board — it dedups by gameId). This is the reliable recorder now
        // that rooms no longer keep-alive after the game ends.
        if (body && body.status === "over" && body.winner) {
          const winnerName: string =
            (body.players ?? []).find((p: { id: string; name: string }) => p.id === body.winner)?.name ??
            body.winner;
          await board.fetch(`http://internal/board`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "recordResult",
              gameId: r.gameId,
              mode: body.mode,
              winner: body.winner,
              winnerName,
              turns: body.turn,
              players: (body.players ?? []).map((p: { name: string }) => p.name),
            }),
          }).catch(() => {});
        }
        return body;
      }),
    );
    const allRooms = detailed.filter(Boolean);
    const want = url.searchParams.get("status");
    const roomsOut =
      want === "live" ? allRooms.filter((r) => r.status === "running")
      : want === "recent" ? allRooms.filter((r) => r.status === "over")
      : allRooms;
    return json({ rooms: roomsOut });
  }

  const roomMatch = path.match(/^\/api\/rooms\/([a-z0-9]{6,16})$/);
  if (roomMatch && request.method === "GET") {
    const gameId = roomMatch[1];
    const res = await roomOp(env, gameId, { op: "state" });
    if (!res) return json({ error: "no such room" }, 404);
    const { state, reports } = res.body;
    // one-time: record the result on the board
    if (state.status === "over" && state.winner) {
      const winnerName = reports?.find((r: { id: string }) => r.id === state.winner)?.name ?? state.winner;
      await env.BOARD.get(env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "recordResult",
          gameId,
          mode: state.mode,
          winner: state.winner,
          winnerName,
          turns: state.turn,
          players: reports?.map((r: { name: string }) => r.name) ?? [],
        }),
      });
    }
    return json({ state, reports });
  }

  // --------------------------------------------------------- training traces
  // LLM agents upload their CoT/tool-call trace (JSONL) after a game. Only the
  // WINNER's trace is surfaced (the board flags the result row when the
  // uploading seat is the recorded winner). GET is public — it's training data.
  const traceMatch = path.match(/^\/api\/rooms\/([a-z0-9]{6,16})\/trace$/);
  if (traceMatch && request.method === "GET") {
    const gameId = traceMatch[1];
    const board = env.BOARD.get(env.BOARD.idFromName("main"));
    const res = await board.fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "getTrace", gameId }),
    });
    if (res.status !== 200) {
      return new Response(await res.text(), {
        status: res.status,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
    const data = (await res.json()) as { agentName: string; content: string };
    const safe = (data.agentName || "agent").replace(/[^a-z0-9-_]+/gi, "_").toLowerCase();
    return new Response(data.content, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="${gameId}-${safe}.jsonl"`,
        "access-control-allow-origin": "*",
      },
    });
  }
  if (traceMatch && request.method === "POST") {
    const gameId = traceMatch[1];
    const token = bearer(request);
    if (!token) return json({ error: "missing bearer token" }, 401);
    const seat = await verifyToken(token, secret);
    if (!seat || seat.gameId !== gameId) return json({ error: "invalid token for this game" }, 401);
    const body = (await request.json().catch(() => ({}))) as {
      agentName?: string;
      model?: string;
      content?: string;
      lines?: number;
    };
    if (!body.content) return json({ error: "content required (JSONL string)" }, 400);
    const board = env.BOARD.get(env.BOARD.idFromName("main"));
    const res = await board.fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "uploadTrace",
        gameId,
        seatId: seat.playerId,
        agentName: body.agentName ?? "",
        model: body.model ?? "",
        content: body.content,
        lines: body.lines ?? 0,
      }),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  if (path === "/api/leaderboard" && request.method === "GET") {
    const res = await env.BOARD.get(env.BOARD.idFromName("main")).fetch(`http://internal/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "listResults", limit: 100 }),
    });
    return new Response(await res.text(), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------- MCP

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const secret = env.MCP_SECRET || "dev";
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  const token = bearer(request);
  if (!token) return json({ error: "missing bearer token" }, 401);
  const seat = await verifyToken(token, secret);
  if (!seat) return json({ error: "invalid token" }, 401);
  const dispatch = async (op: "state" | "apply" | "tick", playerId?: string, move?: Move) => {
    const res = await roomOp(env, seat.gameId, { op, playerId, move });
    if (!res) throw new Error("room gone");
    return res.body;
  };
  return handleMcpRequest(request, seat.gameId, seat.playerId, dispatch);
}

// ---------------------------------------------------------------------- app

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return handleMcp(request, env);
    }

    if (path.startsWith("/game/")) {
      const gameId = path.slice("/game/".length).split("?")[0];
      if (!/^[a-z0-9]{6,16}$/.test(gameId)) return json({ error: "bad gameId" }, 400);
      const room = env.GAME.get(env.GAME.idFromName(gameId));
      if (request.headers.get("upgrade") === "websocket") {
        // forward the upgrade straight to the Durable Object (documented pattern)
        return room.fetch(request);
      }
      const res = await roomOp(env, gameId, { op: "state" });
      return res ? new Response(JSON.stringify(res.body), { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }) : json({ error: "no such room" }, 404);
    }

    if (path.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    if (path === "/") {
      return json({ service: "riskllm", routes: ["/api/rooms", "/api/rooms/:id", "/api/leaderboard", "/game/:id (ws)", "/mcp"] });
    }

    return json({ error: "static assets are served by Cloudflare Pages on the public domain" }, 404);
  },
};
