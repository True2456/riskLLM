import { ADJACENCY, TERRITORY_BY_ID } from "./board";
import type { BotStyle, GameState, Move } from "./types";

/**
 * Canonical per-roll outcomes (exact, see test/dice.test.ts):
 *   1v1: 42/58   2v1: 58/42   3v1: 66/34
 *   2v2: 22.8% take both / 44.8% split / 32.4% lose both (negative-EV)
 *   3v2: 37.2% take both / 29.3% split / 33.6% lose more (only positive-EV vs 2+)
 *
 * Doctrine the bot follows (how humans actually play):
 *  - 2 dice vs a 1-army tile: locked-in campaign win → always do it.
 *  - 3 dice vs a 2-army tile: the only positive-EV multi-die attack → do it
 *    when you can spare the dice.
 *  - anything else: only chipping (aggressive style), 3 dice, weakest target.
 */
interface Candidate {
  from: string;
  to: string;
  defArmies: number;
  dice: number;
  tier: number; // 1 = best
}

function attackCandidates(s: GameState, pid: string, style: BotStyle): Candidate[] {
  const out: Candidate[] = [];
  for (const [from, t] of Object.entries(s.territories)) {
    if (t.owner !== pid || t.armies < 2) continue;
    for (const nb of ADJACENCY[from]) {
      const nt = s.territories[nb];
      if (nt.owner === pid || !nt.owner) continue;
      if (nt.armies === 1) {
        out.push({ from, to: nb, defArmies: 1, dice: Math.min(2, t.armies - 1), tier: 1 });
      } else if (nt.armies === 2 && t.armies >= 4) {
        out.push({ from, to: nb, defArmies: 2, dice: 3, tier: 2 });
      } else if (style === "aggressive" && t.armies >= 5 && nt.armies <= 4) {
        out.push({ from, to: nb, defArmies: nt.armies, dice: 3, tier: 3 });
      }
    }
  }
  // weakest target first, then the attacker that can spare the dice
  return out.sort((a, b) => a.tier - b.tier || a.defArmies - b.defArmies);
}

function myTerr(s: GameState, pid: string): string[] {
  return Object.entries(s.territories)
    .filter(([, t]) => t.owner === pid)
    .map(([id]) => id);
}

/**
 * Choose the next move for `pid`. Returns null when nothing is possible
 * (callers should end the phase/turn).
 */
export function botMove(s: GameState, pid: string, style: BotStyle): Move | null {
  if (s.status === "over" || s.turnOwner !== pid) return null;
  const me = s.players.find((p) => p.id === pid)!;
  const mine = myTerr(s, pid);
  if (mine.length === 0) return { t: "resign" };

  if (s.phase === "reinforce") {
    if (me.cards.length >= 3 && (style !== "turtle" || me.cards.length >= 5)) {
      return { t: "trade_cards" };
    }
    if (s.toReinforce > 0) {
      if (style === "aggressive") {
        // dump everything onto the most contested border
        const borders = mine.filter((id) => ADJACENCY[id].some((nb) => s.territories[nb].owner !== pid));
        const target =
          [...borders].sort(
            (a, b) =>
              ADJACENCY[b].filter((nb) => s.territories[nb].owner !== pid).length -
              ADJACENCY[a].filter((nb) => s.territories[nb].owner !== pid).length,
          )[0] ?? mine[0];
        return { t: "deploy", territory: target, n: s.toReinforce };
      }
      // balanced / turtle: keep every tile alive, then thicken the weak border
      const thin = mine
        .filter((id) => s.territories[id].armies === 1)
        .sort(
          (a, b) =>
            ADJACENCY[b].filter((nb) => s.territories[nb].owner !== pid).length -
            ADJACENCY[a].filter((nb) => s.territories[nb].owner !== pid).length,
        );
      if (thin.length) return { t: "deploy", territory: thin[0], n: 1 };
      const borders = mine
        .filter((id) => ADJACENCY[id].some((nb) => s.territories[nb].owner !== pid))
        .sort((a, b) => s.territories[a].armies - s.territories[b].armies);
      const target = borders[0] ?? mine[0];
      return { t: "deploy", territory: target, n: Math.min(s.toReinforce, style === "turtle" ? 3 : s.toReinforce) };
    }
    return { t: "end_reinforce" };
  }

  if (s.phase === "combat") {
    const cands = attackCandidates(s, pid, style);
    if (style === "turtle") {
      // only take a free 1-army tile when clearly garrisoned
      const free = cands.find((c) => c.tier === 1 && s.territories[c.from].armies >= 4);
      if (free) return { t: "attack", from: free.from, to: free.to, dice: free.dice };
    } else if (cands.length) {
      // don't strip our last big stack to its minimum: keep 3+ on the donor
      const pick = cands.find((c) => s.territories[c.from].armies - c.dice >= 2) ?? cands[0];
      return { t: "attack", from: pick.from, to: pick.to, dice: pick.dice };
    }
    // no good attack: pull strength from the interior to an exposed front
    // (never away from a front — that ping-pongs forever in the unbounded combat phase)
    if (style !== "turtle") {
      const mySet = new Set(mine);
      const interior = mine.filter(
        (id) =>
          s.territories[id].armies >= 3 &&
          !ADJACENCY[id].some((nb) => s.territories[nb].owner !== pid),
      );
      const front = mine.filter(
        (id) =>
          ADJACENCY[id].some((nb) => s.territories[nb].owner !== pid) &&
          s.territories[id].armies < 3,
      );
      for (const from of interior.sort((a, b) => s.territories[b].armies - s.territories[a].armies)) {
        for (const to of front.sort((a, b) => s.territories[a].armies - s.territories[b].armies)) {
          if (ADJACENCY[from].includes(to)) return { t: "move", from, to, n: 2 };
        }
      }
    }
    return { t: "pass_combat" };
  }

  // fortify
  if (s.fortifyMoves >= 1) {
    const borders = mine
      .filter((id) => ADJACENCY[id].some((nb) => s.territories[nb].owner !== pid))
      .sort((a, b) => s.territories[a].armies - s.territories[b].armies);
    for (const b of borders) {
      const friendly = ADJACENCY[b].filter((nb) => s.territories[nb].owner === pid && s.territories[nb].armies >= 2);
      if (friendly.length) {
        const from = friendly.sort((x, y) => s.territories[y].armies - s.territories[x].armies)[0];
        const n = Math.min(3, s.territories[from].armies - 1);
        return { t: "fortify", from, to: b, n };
      }
    }
    // no exposed border: bank strength toward the biggest adjacent threat
    const donors = mine
      .filter((id) => s.territories[id].armies >= 3)
      .sort((a, b) => s.territories[b].armies - s.territories[a].armies);
    if (donors.length) {
      const from = donors[0];
      const friendly = ADJACENCY[from].filter((nb) => s.territories[nb].owner === pid);
      if (friendly.length) return { t: "fortify", from, to: friendly[0], n: 1 };
    }
  }
  return { t: "end_turn" };
}

export const BOT_LABELS: Record<BotStyle, string> = {
  aggressive: "Warmonger",
  balanced: "Strategist",
  turtle: "Tortoise",
};

export { TERRITORY_BY_ID };
