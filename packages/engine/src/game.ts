import {
  ADJACENCY,
  TERRITORIES,
  TERRITORY_BY_ID,
  continentOf,
  ownedPath,
  TOTAL_TERRITORIES,
} from "./board";
import { MODES } from "./modes";
import { rngDie, rngInt, rngSeed, shuffle, type RngState } from "./rng";
import {
  PLAYER_COLORS,
  type BattleFx,
  type CardSymbol,
  type FeedLine,
  type FeedKind,
  type GameState,
  type Move,
  type MoveResult,
  type PlayerReport,
  type PlayerSpec,
  type PlayerState,
  type TerritoryState,
} from "./types";
import { botMove } from "./bot";

const TURN_TIME_MS: Record<string, number> = { agent: 90_000, human: 60_000, bot: 1_000 };
const CARD_VALUE = 5;
const FEED_CAP = 200;

export interface GameConfig {
  gameId: string;
  mode: "blitz" | "classic";
  players: PlayerSpec[];
  seed?: number;
  now?: number;
}

export class Game {
  state: GameState;
  private chatCounts = new Map<string, number>();

  constructor(cfg: GameConfig) {
    const now = cfg.now ?? Date.now();
    const rng = rngSeed(cfg.seed);
    const specCount = cfg.players.length;
    const md = MODES[cfg.mode];
    if (specCount < md.players[0] || specCount > md.players[1]) {
      throw new Error(`${cfg.mode} mode needs ${md.players[0]}–${md.players[1]} players`);
    }

    // --- deal territories: shuffled, in contiguous blocks by count ---
    const order = shuffle(rng, TERRITORIES.map((t) => t.id));
    const territories: Record<string, TerritoryState> = {};
    for (const t of TERRITORIES) territories[t.id] = { owner: null, armies: 0 };

    const base = Math.floor(TOTAL_TERRITORIES / specCount);
    let extra = TOTAL_TERRITORIES - base * specCount;
    const players: PlayerState[] = cfg.players.map((p, i) => ({
      id: p.id,
      name: p.name.slice(0, 32),
      kind: p.kind,
      color: p.color ?? PLAYER_COLORS[i % PLAYER_COLORS.length],
      botStyle: p.kind === "bot" ? (p.botStyle ?? "balanced") : null,
      cards: [],
      eliminated: false,
      lastSeenMs: now,
    }));

    let cursor = 0;
    players.forEach((p) => {
      const count = base + (extra-- > 0 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const id = order[cursor++];
        territories[id].owner = p.id;
        territories[id].armies = 1;
      }
    });

    // --- spread remaining armies ---
    const startArmies = md.startArmies[specCount - 2];
    for (const p of players) {
      const mine = Object.entries(territories)
        .filter(([, t]) => t.owner === p.id)
        .map(([id]) => id);
      let left = startArmies - mine.length;
      while (left > 0) {
        const id = mine[rngInt(rng, mine.length)];
        territories[id].armies += 1;
        left--;
      }
    }

    this.state = {
      game: cfg.gameId,
      mode: cfg.mode,
      status: "running",
      turn: 1,
      phase: "reinforce",
      turnOwner: players[0].id,
      deadlineMs: 0,
      territories,
      players,
      toReinforce: 0,
      fortifyMoves: 0,
      cardsTradeable: false,
      winner: null,
      winReason: null,
      feed: [],
      seed: rng.s,
      rng: { s: rng.s },
      conqueredThisTurn: 0,
      firstConquest: false,
      nextSeq: 1,
    };
    this.pushFeed(null, "game", `${this.state.mode.toUpperCase()} war begins — ${players.map((p) => p.name).join(", ")}`, now);
    this.beginPhase(players[0].id, now);
  }

  static fromState(s: GameState): Game {
    const g = Object.create(Game.prototype) as Game;
    g.state = s;
    g.chatCounts = new Map();
    return g;
  }

  // ---------------------------------------------------------------- helpers

  private get rng(): RngState {
    return this.state.rng;
  }

  private player(id: string): PlayerState {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) throw new Error("unknown player");
    return p;
  }

  ownCount(pid: string, terr?: Record<string, TerritoryState>): number {
    const t = terr ?? this.state.territories;
    return Object.values(t).filter((x) => x.owner === pid).length;
  }

  armyCount(pid: string): number {
    return Object.values(this.state.territories).filter((t) => t.owner === pid).reduce((a, t) => a + t.armies, 0);
  }

  totalArmies(): number {
    return Object.values(this.state.territories).reduce((a, t) => a + t.armies, 0);
  }

  private alivePlayers(): PlayerState[] {
    return this.state.players.filter((p) => !p.eliminated);
  }

  private continentBonus(p: PlayerState): number {
    let b = 0;
    for (const c of [continentOf("ALA"), continentOf("VEN"), continentOf("ICE"), continentOf("NAF"), continentOf("MDE"), continentOf("INDO")]) {
      if (c.territories.every((id) => this.state.territories[id].owner === p.id)) b += c.bonus;
    }
    return b;
  }

  reinforcementsFor(pid: string): number {
    const t = this.ownCount(pid);
    return Math.max(3, Math.ceil(t / 3)) + this.continentBonus(this.player(pid));
  }

  pushFeed(pid: string | null, kind: FeedKind, text: string, now: number, fx?: BattleFx) {
    const s = this.state;
    s.feed.push({ seq: s.nextSeq++, turn: s.turn, playerId: pid, kind, text, ts: now, fx });
    if (s.feed.length > FEED_CAP) s.feed.splice(0, s.feed.length - FEED_CAP);
  }

  // ------------------------------------------------------------- turn flow

  private beginPhase(pid: string, now: number) {
    const s = this.state;
    s.turnOwner = pid;
    s.phase = "reinforce";
    s.toReinforce = this.reinforcementsFor(pid);
    s.fortifyMoves = 0;
    s.conqueredThisTurn = 0;
    this.player(pid).lastSeenMs = now;
    s.deadlineMs = now + (TURN_TIME_MS[this.player(pid).kind] ?? 60_000);
    this.pushFeed(pid, "turn", `${this.player(pid).name} takes the field (turn ${s.turn})`, now);
  }

  private nextTurn(now: number): boolean {
    const s = this.state;
    const alive = this.alivePlayers();
    if (alive.length <= 1) return false;
    const idx = alive.findIndex((p) => p.id === s.turnOwner);
    let next = alive[idx + 1];
    if (!next) {
      next = alive[0];
      s.turn += 1;
      if (s.mode === "blitz" && MODES.blitz.suddenDeathTurn && s.turn > MODES.blitz.suddenDeathTurn) {
        this.suddenDeath(now);
        return false;
      }
    }
    this.beginPhase(next.id, now);
    return true;
  }

  private suddenDeath(now: number) {
    const s = this.state;
    const alive = this.alivePlayers();
    const top = [...alive].sort((a, b) => {
      const da = this.armyCount(a.id), db = this.armyCount(b.id);
      if (db !== da) return db - da;
      return this.ownCount(b.id) - this.ownCount(a.id);
    })[0];
    this.finish(top.id, "sudden death — most armies at the deadline", now);
  }

  private checkVictory(now: number) {
    const s = this.state;
    if (s.status !== "running") return;
    const alive = this.alivePlayers();
    if (alive.length === 1) {
      this.finish(alive[0].id, "world conquest", now);
      return;
    }
    // Share wins reward a DECISIVE lead, and only start being checked once the
    // game has had a few turns to build one (turn < 4 is pure reinforcement math —
    // the biggest starter would otherwise win on turn 3). Thresholds are set so a
    // share win means "clearly on top" rather than "slightly ahead":
    //   2p: 55% (a real lead over an equal-opener)  3p: 50% (bigger than the other two
    //   combined)  4p: 45%. Otherwise games run to elimination or sudden death.
    if (s.turn >= 4 && s.firstConquest) {
      const share = alive.length === 2 ? 0.55 : alive.length === 3 ? 0.5 : 0.45;
      const total = this.totalArmies();
      for (const p of alive) {
        if (this.armyCount(p.id) / total >= share) {
          this.finish(p.id, `held ${Math.round(share * 100)}% of all armies`, now);
          return;
        }
      }
    }
  }

  private finish(winnerId: string, reason: string, now: number) {
    const s = this.state;
    s.status = "over";
    s.winner = winnerId;
    s.winReason = reason;
    s.turnOwner = null;
    s.deadlineMs = 0;
    this.pushFeed(winnerId, "game", `🏆 ${this.player(winnerId).name} wins! ${reason}`, now);
  }

  private eliminate(p: PlayerState, by: string | null, now: number) {
    if (p.eliminated) return;
    p.eliminated = true;
    if (by) this.player(by).cards.push(...p.cards);
    p.cards = [];
    this.pushFeed(null, "elim", `${p.name} is eliminated${by ? ` by ${this.player(by).name}` : ""}`, now);
  }

  // ------------------------------------------------------------- the engine

  apply(playerId: string, move: Move, now = Date.now()): MoveResult {
    const s = this.state;
    if (s.status === "over") return { ok: false, error: "game is over", state: s };
    if (s.turnOwner !== playerId) return { ok: false, error: "not your turn", state: s };
    const me = this.player(playerId);

    try {
      switch (move.t) {
        case "deploy": {
          if (s.phase !== "reinforce") throw e("only during reinforce");
          const t = s.territories[move.territory];
          if (!t || t.owner !== me.id) throw e("you do not control that territory");
          const n = Math.min(move.n, s.toReinforce);
          if (n < 1) throw e("nothing left to deploy");
          t.armies += n;
          s.toReinforce -= n;
          this.pushFeed(me.id, "deploy", `${me.name} deploys ${n} → ${TERRITORY_BY_ID[move.territory].name}`, now);
          break;
        }
        case "trade_cards": {
          if (s.phase !== "reinforce") throw e("only during reinforce");
          if (me.cards.length < 3) throw e("need 3 cards");
          me.cards.splice(0, 3);
          s.toReinforce += CARD_VALUE;
          this.pushFeed(me.id, "trade", `${me.name} trades cards for ${CARD_VALUE} armies`, now);
          break;
        }
        case "end_reinforce": {
          if (s.phase !== "reinforce") throw e("already reinforced");
          s.phase = "combat";
          this.pushFeed(me.id, "pass", `${me.name} deploys done — combat begins`, now);
          break;
        }
        case "attack": {
          if (s.phase !== "combat") throw e("combat phase only");
          const from = s.territories[move.from];
          const to = s.territories[move.to];
          if (!from || !to || from.owner !== me.id) throw e("you do not control the attacking territory");
          if (!ADJACENCY[move.from]?.includes(move.to)) throw e("not adjacent");
          if (to.owner === me.id) throw e("cannot attack yourself");
          if (from.armies < 2) throw e("need at least 2 armies to attack");
          const dice = Math.min(move.dice, from.armies - 1, 3);
          if (dice < 1) throw e("not enough armies to roll");

          const attDice = Array.from({ length: dice }, () => rngDie(this.rng)).sort((a, b) => b - a);
          const defDice = Array.from({ length: Math.min(2, to.armies) }, () => rngDie(this.rng)).sort((a, b) => b - a);
          const oldOwner = to.owner;
          let attLost = 0;
          let defLost = 0;
          for (let i = 0; i < attDice.length; i++) {
            if (defLost >= to.armies) break; // territory already taken — roll ends
            const d = defDice.length ? defDice[Math.min(i, defDice.length - 1)] : 0;
            if (attDice[i] > d) defLost++;
            else attLost++;
          }
          from.armies -= attLost;
          to.armies -= defLost;
          const conquered = to.armies <= 0;
          if (conquered) {
            const moved = Math.min(dice, Math.max(0, from.armies - 1));
            to.owner = me.id;
            to.armies = moved;
            from.armies -= moved;
            s.conqueredThisTurn += 1;
            s.firstConquest = true;
            this.pushFeed(me.id, "conquest", `${me.name} conquers ${TERRITORY_BY_ID[move.to].name}!`, now, {
              type: "battle", from: move.from, to: move.to, attRoll: attDice, defRoll: defDice,
              attLost, defLost, conquered: true,
            });
            if (oldOwner && oldOwner !== me.id) {
              const op = this.state.players.find((p) => p.id === oldOwner);
              if (op && this.ownCount(op.id) === 0) this.eliminate(op, me.id, now);
            }
          } else {
            this.pushFeed(
              me.id, "attack",
              `${me.name} attacks ${TERRITORY_BY_ID[move.to].name}: ${attDice.join("·")} vs ${defDice.join("·")} — defender loses ${defLost}`,
              now, { type: "battle", from: move.from, to: move.to, attRoll: attDice, defRoll: defDice, attLost, defLost, conquered: false },
            );
          }
          this.checkVictory(now);
          break;
        }
        case "move": {
          if (s.phase !== "combat") throw e("combat phase only");
          const from = s.territories[move.from];
          const to = s.territories[move.to];
          if (!from || !to || from.owner !== me.id || to.owner !== me.id) throw e("both territories must be yours");
          if (!ADJACENCY[move.from]?.includes(move.to)) throw e("not adjacent");
          if (move.from === move.to) throw e("same territory");
          const n = Math.min(move.n ?? from.armies - 1, from.armies - 1);
          if (n < 1) throw e("must leave 1 army behind");
          from.armies -= n;
          to.armies += n;
          this.pushFeed(me.id, "move", `${me.name} shifts ${n} ${TERRITORY_BY_ID[move.from].name} → ${TERRITORY_BY_ID[move.to].name}`, now);
          break;
        }
        case "pass_combat": {
          if (s.phase !== "combat") throw e("combat phase only");
          s.phase = "fortify";
          s.fortifyMoves = 3;
          this.pushFeed(me.id, "pass", `${me.name} ends combat — fortify`, now);
          break;
        }
        case "fortify": {
          if (s.phase !== "fortify") throw e("fortify phase only");
          if (s.fortifyMoves < 1) throw e("no fortify moves left");
          const from = s.territories[move.from];
          const to = s.territories[move.to];
          if (!from || !to || from.owner !== me.id || to.owner !== me.id) throw e("both territories must be yours");
          if (move.from === move.to) throw e("same territory");
          const owned = new Set(Object.entries(s.territories).filter(([, t]) => t.owner === me.id).map(([id]) => id));
          if (!ownedPath(move.from, move.to, me.id, owned)) throw e("no path through your empire");
          const n = Math.min(move.n ?? from.armies - 1, from.armies - 1);
          if (n < 1) throw e("must leave 1 army behind");
          from.armies -= n;
          to.armies += n;
          s.fortifyMoves -= 1;
          this.pushFeed(me.id, "fortify", `${me.name} fortifies ${TERRITORY_BY_ID[move.to].name} (+${n})`, now);
          break;
        }
        case "end_turn": {
          if (s.phase === "combat") {
            s.phase = "fortify";
            s.fortifyMoves = 3;
            this.pushFeed(me.id, "pass", `${me.name} ends combat`, now);
            break;
          }
          if (s.phase !== "fortify") throw e("finish combat first");
          this.awardCardIfDue();
          this.nextTurn(now);
          break;
        }
        case "resign": {
          this.eliminate(me, null, now);
          this.checkVictory(now);
          if (s.status === "running" && this.alivePlayers().length > 1 && s.turnOwner === me.id) this.nextTurn(now);
          break;
        }
        case "chat": {
          const msg = move.msg.slice(0, 140).replace(/\r?\n/g, " ");
          if (!msg.trim()) throw e("empty message");
          this.pushFeed(me.id, "chat", `${me.name}: ${msg}`, now);
          break;
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: s };
    }
    // mark active + refresh deadline bookkeeping
    me.lastSeenMs = now;
    return { ok: true, state: s };
  }

  /**
   * Advance the game when it is a bot's turn or a player hit their deadline.
   * Safe to call often (every WS/MCP/API hit, and from alarms). Returns the
   * last applied move's result, or null if nothing happened.
   */
  tick(now: number): MoveResult | null {
    const s = this.state;
    if (s.status !== "running" || !s.turnOwner) return null;
    let last: MoveResult | null = null;
    let guard = 0;
    // Announce the auto-pilot once per player per turn, not once per move —
    // the old code pushed "takes command" before every botMove and the war
    // feed was 90% noise.
    let announcedFor: string | null = null;
    while (s.status === "running" && s.turnOwner && guard++ < 400) {
      const owner = this.player(s.turnOwner);
      const overdue = now >= s.deadlineMs;
      if (!overdue && owner.kind !== "bot") break;
      const style = owner.kind === "bot" ? owner.botStyle ?? "balanced" : "balanced";
      if (announcedFor !== owner.id) {
        if (!overdue) this.pushFeed(owner.id, "turn", `${owner.name} (auto-pilot) takes command`, now);
        else if (owner.kind !== "bot") this.pushFeed(null, "deadline", `⏱ ${owner.name} ran out of time — auto-pilot engaged`, now);
        announcedFor = owner.id;
      }
      const mv = botMove(this.state, owner.id, style);
      if (mv) {
        last = this.apply(owner.id, mv, now);
        if (!last.ok) {
          // bot brain returned something illegal (shouldn't happen) — force the phase forward
          this.forceEndPhase(now);
        }
      } else {
        this.forceEndPhase(now);
      }
    }
    return last;
  }

  private awardCardIfDue(now = Date.now()) {
    const s = this.state;
    if (s.conqueredThisTurn > 0 && s.turnOwner) {
      const me = this.player(s.turnOwner);
      const card: CardSymbol = (["infantry", "cavalry", "artillery"] as const)[rngInt(this.rng, 3)];
      me.cards.push(card);
      this.pushFeed(me.id, "trade", `${me.name} takes a ${card} card`, now);
    }
  }

  /** Phase/turn advance that never throws — used by the auto-pilot fallback. */
  private forceEndPhase(now: number) {
    const s = this.state;
    if (!s.turnOwner) return;
    if (s.phase === "reinforce") {
      s.phase = "combat";
    } else if (s.phase === "combat") {
      s.phase = "fortify";
      s.fortifyMoves = 3;
    } else {
      this.awardCardIfDue(now);
      this.nextTurn(now);
    }
  }

  // ------------------------------------------------------------ MCP helpers

  reports(): PlayerReport[] {
    const s = this.state;
    return s.players.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      color: p.color,
      botStyle: p.botStyle,
      cards: p.cards,
      territories: this.ownCount(p.id),
      armies: this.armyCount(p.id),
      alive: !p.eliminated,
      isTurn: p.id === s.turnOwner,
      deadlineMs: s.turnOwner === p.id ? s.deadlineMs : 0,
    }));
  }

  /** Compact list of legal actions — used as hints in MCP tool results. */
  legalActions(pid: string): string[] {
    const s = this.state;
    const out: string[] = [];
    const mine = Object.entries(s.territories).filter(([, t]) => t.owner === pid);
    if (s.phase === "reinforce") {
      if (s.toReinforce > 0) out.push(`deploy <territory> <n> (have ${s.toReinforce})`);
      if (this.player(pid).cards.length >= 3) out.push("trade_cards");
      out.push("end_reinforce");
    } else if (s.phase === "combat") {
      for (const [from] of mine) {
        const armies = s.territories[from].armies;
        if (armies < 2) continue;
        for (const nb of ADJACENCY[from]) {
          const t = s.territories[nb];
          if (t.owner !== pid) out.push(`attack ${from}→${nb} (def ${t.armies})`);
          else if (armies > 1) out.push(`move ${from}→${nb}`);
        }
      }
      out.push("pass_combat");
    } else {
      for (const [from] of mine) {
        if (s.territories[from].armies < 2) continue;
        const owned = new Set(mine.map(([id]) => id));
        for (const nb of ADJACENCY[from]) {
          if (owned.has(nb)) out.push(`fortify ${from}→${nb}`);
        }
      }
      out.push("end_turn");
    }
    out.push("resign");
    return out;
  }
}

function e(msg: string): Error {
  return new Error(msg);
}
