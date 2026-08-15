// Local solo games: the engine runs entirely in the browser (no server).
// A 500ms interval drives g.tick() while it's a bot's turn or a player is
// overdue (the engine's house-bot brain auto-plays), so bot-only wars run
// live and human turns get instant bot responses.

import {
  Game,
  type BotStyle,
  type GameState,
  type Move,
  type MoveResult,
  type PlayerReport,
  type PlayerSpec,
} from "@riskllm/engine";

export interface SoloSeat {
  kind: "human" | "agent" | "bot";
  name?: string;
  botStyle?: BotStyle;
}

export interface SoloSession {
  id: string;
  game: Game;
  /** bumped on every state change — use as a React re-render key */
  version: number;
  applyAsHuman(move: Move): MoveResult;
  subscribe(fn: () => void): () => void;
}

const sessions = new Map<string, SoloSession>();

export function startSolo(opts: { mode: "blitz" | "classic"; seats: SoloSeat[]; seed?: number }): SoloSession {
  const id = "solo-" + Math.random().toString(36).slice(2, 10);
  const specs: PlayerSpec[] = opts.seats.map((s, i) => ({
    id: `p${i + 1}`,
    name: s.name?.trim() || (s.kind === "human" ? "You" : s.kind === "agent" ? "Agent" : `Bot ${i + 1}`),
    kind: s.kind,
    botStyle: s.botStyle ?? "balanced",
  }));
  const game = new Game({
    gameId: id,
    mode: opts.mode,
    players: specs,
    seed: opts.seed ?? Math.floor(Math.random() * 1e9),
    now: Date.now(),
  });

  const listeners = new Set<() => void>();
  const session: SoloSession = { id, game, version: 0, applyAsHuman, subscribe };

  function notify() {
    session.version += 1;
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* listener bug — never break the game loop */
      }
    }
  }

  function applyAsHuman(move: Move): MoveResult {
    const human = specs.find((s) => s.kind === "human");
    if (!human) return { ok: false, error: "no human seat in this game", state: game.state };
    const res = game.apply(human.id, move, Date.now());
    game.tick(Date.now()); // advance bots / overdue players immediately
    notify();
    return res;
  }

  function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  sessions.set(id, session);

  // Drive the game while bots act or anyone is overdue.
  window.setInterval(() => {
    const s = game.state;
    if (s.status !== "running" || !s.turnOwner) return;
    const owner = s.players.find((p) => p.id === s.turnOwner);
    const botTurn = owner?.kind === "bot";
    const overdue = s.deadlineMs > 0 && Date.now() >= s.deadlineMs;
    if (!botTurn && !overdue) return;
    game.tick(Date.now());
    notify();
  }, 500);

  // Kick: if the first seat is a bot (bot-only war) start moving right away.
  game.tick(Date.now());
  notify();
  return session;
}

export function getSolo(id: string): SoloSession | undefined {
  return sessions.get(id);
}

export function soloState(s: SoloSession): GameState {
  return s.game.state;
}

export function soloReports(s: SoloSession): PlayerReport[] {
  return s.game.reports();
}
