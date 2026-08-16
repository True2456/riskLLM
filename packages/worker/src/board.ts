/**
 * Singleton Durable Object: the arena registry + leaderboard.
 * SQLite-backed (free on Workers free plan). Stores live/finished room
 * metadata and recent results.
 */
export class Board {
  private ready = false;

  constructor(private state: DurableObjectState, _env: Env) {}

  private async db() {
    const sql = this.state.storage.sql;
    if (!this.ready) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          gameId TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          winner TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gameId TEXT NOT NULL,
          mode TEXT NOT NULL,
          winner TEXT,
          winnerName TEXT,
          turns INTEGER,
          players TEXT,
          finishedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS traces (
          gameId TEXT NOT NULL,
          seatId TEXT NOT NULL,
          agentName TEXT NOT NULL,
          model TEXT,
          uploadedAt INTEGER NOT NULL,
          lines INTEGER NOT NULL,
          content TEXT NOT NULL,
          PRIMARY KEY (gameId, seatId)
        );
      `);
      // Guarded migration: add traceAgent to pre-existing results tables
      // (no-op error if the column is already there).
      try {
        sql.exec(`ALTER TABLE results ADD COLUMN traceAgent TEXT`);
      } catch {
        /* already exists */
      }
      this.ready = true;
    }
    return sql;
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      op?: string;
      gameId?: string;
      mode?: string;
      status?: string;
      winner?: string | null;
      winnerName?: string;
      turns?: number;
      players?: string[];
      limit?: number;
      seatId?: string;
      agentName?: string;
      model?: string;
      content?: string;
      lines?: number;
    };
    const sql = await this.db();
    const now = Date.now();
    switch (body.op) {
      case "register": {
        sql.exec(
          `INSERT OR REPLACE INTO rooms (gameId, mode, status, winner, createdAt, updatedAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          body.gameId ?? "", body.mode ?? "blitz", body.status ?? "running", body.winner ?? null, now, now,
        );
        return json({ ok: true });
      }
      case "update": {
        sql.exec(
          `UPDATE rooms SET status = ?2, winner = ?3, updatedAt = ?4 WHERE gameId = ?1`,
          body.gameId ?? "", body.status ?? "running", body.winner ?? null, now,
        );
        return json({ ok: true });
      }
      case "listRooms": {
        const limit = Math.min(30, body.limit ?? 12);
        // DO SQLite rows are objects keyed by column name (not positional tuples).
        const rows = sql
          .exec(`SELECT gameId, mode, status, winner, createdAt FROM rooms ORDER BY updatedAt DESC LIMIT ?1`, limit)
          .toArray() as unknown as Record<string, unknown>[];
        return json({
          rooms: rows.map((r) => ({
            gameId: String(r.gameId),
            mode: String(r.mode),
            status: String(r.status),
            winner: (r.winner as string | null) ?? null,
            createdAt: Number(r.createdAt),
          })),
        });
      }
      case "recordResult": {
        if (!body.gameId) return json({ error: "gameId required" }, 400);
        const done = sql.exec(`SELECT COUNT(*) AS c FROM results WHERE gameId = ?1`, body.gameId).one() as unknown as Record<string, unknown> | null;
        if (done && Number(done.c ?? 0) > 0) return json({ ok: true, dedup: true });
        sql.exec(
          `INSERT INTO results (gameId, mode, winner, winnerName, turns, players, finishedAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          body.gameId, body.mode ?? "blitz", body.winner ?? null, body.winnerName ?? null,
          body.turns ?? 0, JSON.stringify(body.players ?? []), now,
        );
        sql.exec(`UPDATE rooms SET status = 'over', winner = ?2, updatedAt = ?3 WHERE gameId = ?1`,
          body.gameId, body.winner ?? null, now);
        return json({ ok: true });
      }
      case "listResults": {
        const limit = Math.min(100, body.limit ?? 50);
        const rows = sql
          .exec(`SELECT gameId, mode, winnerName, turns, players, finishedAt, traceAgent FROM results ORDER BY finishedAt DESC LIMIT ?1`, limit)
          .toArray() as unknown as Record<string, unknown>[];
        return json({
          results: rows.map((r) => ({
            gameId: String(r.gameId),
            mode: String(r.mode),
            winnerName: (r.winnerName as string | null) ?? null,
            turns: Number(r.turns),
            players: JSON.parse(String(r.players ?? "[]")) as string[],
            finishedAt: Number(r.finishedAt),
            traceAgent: (r.traceAgent as string | null) ?? null,
          })),
        });
      }
      case "uploadTrace": {
        const { gameId, seatId, agentName, model, content, lines } = body;
        if (!gameId || !seatId || !content) return json({ error: "gameId, seatId, content required" }, 400);
        sql.exec(
          `INSERT OR REPLACE INTO traces (gameId, seatId, agentName, model, uploadedAt, lines, content)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          gameId, seatId, agentName ?? "", model ?? "", now, lines ?? 0, content,
        );
        // If this seat is the game's winner, flag the result row so the lobby
        // can show the download button. Losing traces are stored but not flagged.
        sql.exec(`UPDATE results SET traceAgent = ?3 WHERE gameId = ?1 AND winner = ?2`,
          gameId, seatId, agentName ?? "");
        return json({ ok: true, stored: true });
      }
      case "getTrace": {
        const gameId = body.gameId ?? "";
        if (!gameId) return json({ error: "gameId required" }, 400);
        // Winner's trace: join traces to results where the trace's seat is the
        // recorded winner (results.winner holds the winning seatId).
        const row = sql
          .exec(
            `SELECT t.agentName, t.model, t.lines, t.content, t.uploadedAt, r.winnerName
             FROM traces t JOIN results r ON r.gameId = t.gameId
             WHERE t.gameId = ?1 AND r.winner = t.seatId`,
            gameId,
          )
          .one() as unknown as Record<string, unknown> | null;
        if (row) {
          return json({
            gameId,
            agentName: String(row.agentName),
            winnerName: (row.winnerName as string | null) ?? null,
            model: (row.model as string | null) ?? null,
            lines: Number(row.lines),
            uploadedAt: Number(row.uploadedAt),
            content: String(row.content),
          });
        }
        // Fallback: the only trace on record for this game.
        const solo = sql
          .exec(`SELECT agentName, model, lines, content, uploadedAt FROM traces WHERE gameId = ?1 LIMIT 1`, gameId)
          .one() as unknown as Record<string, unknown> | null;
        if (!solo) return json({ error: "no trace for this game" }, 404);
        return json({
          gameId,
          agentName: String(solo.agentName),
          winnerName: null,
          model: (solo.model as string | null) ?? null,
          lines: Number(solo.lines),
          uploadedAt: Number(solo.uploadedAt),
          content: String(solo.content),
        });
      }
      default:
        return json({ error: "unknown op" }, 400);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
