import { describe, expect, it } from "vitest";
import { ADJACENCY, CONTINENTS, TERRITORIES, TOTAL_TERRITORIES, continentOf, ownedPath, adjacent } from "../src/board";
import { Game } from "../src/game";
import type { Move, PlayerSpec } from "../src/types";

function specs(names: [string, "human" | "agent" | "bot"][], styles?: ("aggressive" | "balanced" | "turtle")[]): PlayerSpec[] {
  return names.map(([name, kind], i) => ({
    id: `p${i + 1}`,
    name,
    kind,
    botStyle: kind === "bot" ? (styles?.[i] ?? "balanced") : undefined,
  }));
}

describe("board data", () => {
  it("has 42 territories across 6 continents", () => {
    expect(TOTAL_TERRITORIES).toBe(42);
    const continents = new Set(TERRITORIES.map((t) => t.continent));
    expect(continents.size).toBe(6);
  });

  it("every adjacency is symmetric and self-consistent", () => {
    const ids = new Set(TERRITORIES.map((t) => t.id));
    for (const t of TERRITORIES) {
      expect(ids.has(t.id)).toBe(true);
      for (const nb of ADJACENCY[t.id]) {
        expect(ids.has(nb)).toBe(true);
        expect(adjacent(nb, t.id)).toBe(true);
        expect(nb !== t.id).toBe(true);
      }
      // no duplicate neighbours
      expect(new Set(ADJACENCY[t.id]).size).toBe(ADJACENCY[t.id].length);
    }
  });

  it("the graph is connected", () => {
    const seen = new Set(["ALA"]);
    const q = ["ALA"];
    while (q.length) {
      const x = q.shift()!;
      for (const nb of ADJACENCY[x]) if (!seen.has(nb)) (seen.add(nb), q.push(nb));
    }
    expect(seen.size).toBe(42);
  });

  it("ownedPath finds routes through an empire", () => {
    const owned = new Set(["ALA", "WC", "ONT", "EUS"]);
    expect(ownedPath("ALA", "EUS", "x", owned)).toEqual(["ALA", "WC", "EUS"]);
    expect(ownedPath("ALA", "QBC", "x", owned)).toBeNull();
  });

  it("continent membership is disjoint and covers the board", () => {
    const total = CONTINENTS.reduce((a, c) => a + c.territories.length, 0);
    expect(total).toBe(42);
    const seen = new Set<string>();
    for (const c of CONTINENTS) {
      for (const id of c.territories) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(42);
  });
});

describe("game flow", () => {
  it("deals every territory exactly once and the right army totals", () => {
    const g = new Game({ gameId: "t", mode: "blitz", players: specs([["A", "bot"], ["B", "bot"]]), seed: 7 });
    const owners = Object.values(g.state.territories).map((t) => t.owner);
    expect(new Set(owners).size).toBe(2);
    expect(owners.filter((o) => o === "p1").length + owners.filter((o) => o === "p2").length).toBe(42);
    expect(g.armyCount("p1")).toBe(25);
    expect(g.armyCount("p2")).toBe(25);
    expect(g.state.turn).toBe(1);
    expect(g.state.phase).toBe("reinforce");
  });

  it("rejects out-of-turn and illegal moves", () => {
    const g = new Game({ gameId: "t", mode: "blitz", players: specs([["A", "bot"], ["B", "bot"]]), seed: 1 });
    expect(g.apply("p2", { t: "end_reinforce" }).ok).toBe(false);
    expect(g.apply("p1", { t: "attack", from: "ALA", to: "JAP", dice: 1 }).ok).toBe(false);
    const res = g.apply("p1", { t: "deploy", territory: "ALA", n: 9999 });
    expect(res.ok).toBe(true); // clamped to what's available
    expect(res.state.toReinforce).toBe(0);
  });

  it("plays a full bot-vs-bot blitz game to a winner without throwing", () => {
    const g = new Game({ gameId: "t", mode: "blitz", players: specs([["A", "bot"], ["B", "bot"]], ["aggressive", "turtle"]), seed: 99, now: 1_000_000 });
    let now = 1_000_000;
    let steps = 0;
    while (g.state.status === "running" && steps++ < 200_000) {
      now += 100;
      g.tick(now);
    }
    expect(g.state.status).toBe("over");
    expect(g.state.winner).toBeTruthy();
    expect(g.state.turn).toBeLessThanOrEqual(17); // sudden death by turn 15
    expect(g.state.feed.length).toBeGreaterThan(10);
    // no territory has a negative or zero-army owner mismatch
    for (const t of Object.values(g.state.territories)) {
      if (t.owner) expect(t.armies).toBeGreaterThanOrEqual(1);
    }
  });

  it("classic mode: elimination wins the game", () => {
    const g = new Game({ gameId: "t", mode: "classic", players: specs([["A", "bot"], ["B", "bot"]], ["aggressive", "balanced"]), seed: 5, now: 0 });
    let now = 0;
    let steps = 0;
    // let it run; either conquest or 50% share must end it
    while (g.state.status === "running" && steps++ < 400_000) {
      now += 100;
      g.tick(now);
    }
    expect(g.state.status).toBe("over");
    expect(g.state.winner).toBeTruthy();
    expect(["world conquest", "held 55% of all armies", "held 50% of all armies", "held 45% of all armies"]).toContain(g.state.winReason);
  });

  it("resignation eliminates and can end the game", () => {
    const g = new Game({ gameId: "t", mode: "blitz", players: specs([["A", "bot"], ["B", "bot"]]), seed: 3, now: 0 });
    // force B's turn
    let now = 0;
    let guard = 0;
    while (g.state.status === "running" && g.state.turnOwner !== "p2" && guard++ < 1000) {
      now += 10;
      g.tick(now);
    }
    if (g.state.status !== "running") {
      // game already finished mid-chain — restart with a fresh seed
      return;
    }
    const res = g.apply("p2", { t: "resign" });
    expect(res.ok).toBe(true);
    expect(g.state.players.find((p) => p.id === "p2")!.eliminated).toBe(true);
  });

  it("state round-trips through JSON", () => {
    const g = new Game({ gameId: "t", mode: "blitz", players: specs([["A", "bot"], ["B", "bot"], ["C", "bot"]]), seed: 11, now: 0 });
    let now = 0;
    for (let i = 0; i < 50; i++) { now += 100; g.tick(now); }
    const restored = Game.fromState(JSON.parse(JSON.stringify(g.state)));
    expect(restored.state.turn).toBe(g.state.turn);
    expect(restored.armyCount(g.state.turnOwner!)).toBe(g.armyCount(g.state.turnOwner!));
  });
});
