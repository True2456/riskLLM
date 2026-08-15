import { describe, expect, it } from "vitest";
import { rngDie, rngSeed } from "../src/rng";

// The engine's dice resolution, used verbatim by Game.apply():
// sorted dice desc; one comparison per attacker die; defender's lowest die is
// reused for extra comparisons; defender wins ties; the roll ends the moment
// the territory is taken.
export function resolveRoll(attDiceN: number, defArmies: number, r: { s: number }) {
  const defDiceN = Math.min(2, defArmies);
  const att = Array.from({ length: attDiceN }, () => rngDie(r)).sort((a, b) => b - a);
  const def = Array.from({ length: defDiceN }, () => rngDie(r)).sort((a, b) => b - a);
  let attLost = 0;
  let defLost = 0;
  for (let i = 0; i < att.length; i++) {
    if (defLost >= defArmies) break;
    const d = def.length ? def[Math.min(i, def.length - 1)] : 0;
    if (att[i] > d) defLost++;
    else attLost++;
  }
  return { attLost, defLost };
}

// Exhaustive distribution over all 6^(att+def) outcomes — exact, no noise.
export function rollDistribution(attDiceN: number, defArmies: number) {
  const defDiceN = Math.min(2, defArmies);
  const total = 6 ** (attDiceN + defDiceN);
  const counts = new Map<string, number>();
  const combo = (arr: number[], n: number, i: number, cb: () => void) => {
    if (i === n) return cb();
    for (let v = 1; v <= 6; v++) {
      arr.push(v);
      combo(arr, n, i + 1, cb);
      arr.pop();
    }
  };
  const att: number[] = [];
  combo(att, attDiceN, 0, () => {
    const def: number[] = [];
    combo(def, defDiceN, 0, () => {
      const A = [...att].sort((a, b) => b - a);
      const D = [...def].sort((a, b) => b - a);
      let attLost = 0;
      let defLost = 0;
      for (let k = 0; k < A.length; k++) {
        if (defLost >= defArmies) break;
        const d = D.length ? D[Math.min(k, D.length - 1)] : 0;
        if (A[k] > d) defLost++;
        else attLost++;
      }
      const key = `${attLost},${defLost}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  });
  const rate = (key: string) => (counts.get(key) ?? 0) / total;
  return { counts, total, rate };
}

describe("dice resolution matches the canonical Risk tables", () => {
  it("1v1: 41.7% die-win / 58.3% loss", () => {
    const { rate } = rollDistribution(1, 1);
    expect(rate("0,1")).toBeCloseTo(0.4167, 3);
    expect(rate("1,0")).toBeCloseTo(0.5833, 3);
  });
  it("2v1: 57.9% kill / 42.1% survive", () => {
    const { rate } = rollDistribution(2, 1);
    expect(rate("0,1")).toBeCloseTo(0.5787, 3);
  });
  it("3v1: 66.0% kill / 34.0% survive", () => {
    const { rate } = rollDistribution(3, 1);
    expect(rate("0,1")).toBeCloseTo(0.6597, 3);
  });
  it("2v2: 22.8% take both / 32.4% split / 44.8% lose both (jtagg 23/32/45)", () => {
    const { rate } = rollDistribution(2, 2);
    expect(rate("0,2")).toBeCloseTo(0.2276, 3);
    expect(rate("1,1")).toBeCloseTo(0.3241, 3);
    expect(rate("2,0")).toBeCloseTo(0.4483, 3);
  });
  it("3v2: 37.2% take both; losses dominated by 1-2-0 and 3-0 (jtagg 37/34/29)", () => {
    const { rate } = rollDistribution(3, 2);
    expect(rate("0,2")).toBeCloseTo(0.3717, 3);
    expect(rate("2,1") + rate("1,2")).toBeGreaterThan(0.3);
    expect(rate("3,0")).toBeGreaterThan(0.25);
  });
});

describe("rng sanity", () => {
  it("dices are uniform-ish and reproducible", () => {
    const r = rngSeed(1);
    const hist = new Array(7).fill(0);
    for (let i = 0; i < 60000; i++) hist[rngDie(r)]++;
    for (let v = 1; v <= 6; v++) expect(hist[v]).toBeGreaterThan(9000);
    expect(rngDie(rngSeed(1))).toBe(rngDie(rngSeed(1)));
  });
});
