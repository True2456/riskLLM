// Small, serializable, deterministic RNG (mulberry32).

export interface RngState {
  s: number;
}

export function rngSeed(seed?: number): RngState {
  let x = (seed ?? (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) >>> 0;
  // mix a bit so nearby seeds don't correlate
  x = (x ^ 0x9e3779b9) >>> 0;
  return { s: x };
}

export function rngNext(r: RngState): number {
  let t = (r.s += 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rngInt(r: RngState, maxExclusive: number): number {
  return Math.floor(rngNext(r) * maxExclusive);
}

export function rngDie(r: RngState): number {
  return 1 + rngInt(r, 6);
}

/** Fisher–Yates shuffle, in place. */
export function shuffle<T>(r: RngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rngInt(r, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
