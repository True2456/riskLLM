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
      `);
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
          .exec(`SELECT gameId, mode, winnerName, turns, players, finishedAt FROM results ORDER BY finishedAt DESC LIMIT ?1`, limit)
          .toArray() as unknown as Record<string, unknown>[];
        return json({
          results: rows.map((r) => ({
            gameId: String(r.gameId),
            mode: String(r.mode),
            winnerName: (r.winnerName as string | null) ?? null,
            turns: Number(r.turns),
            players: JSON.parse(String(r.players ?? "[]")) as string[],
            finishedAt: Number(r.finishedAt),
          })),
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
