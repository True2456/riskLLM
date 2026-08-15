export interface GameMode {
  id: "blitz" | "classic";
  players: [number, number]; // min, max
  startArmies: number[]; // indexed by playerCount-2 (2..6)
  winArmyShare: number | null; // conquer X share of all armies
  suddenDeathTurn: number | null; // after this turn, most armies wins
}

export const MODES: Record<string, GameMode> = {
  blitz: {
    id: "blitz",
    players: [2, 4],
    startArmies: [25, 20, 16],
    winArmyShare: 0.3,
    suddenDeathTurn: 15,
  },
  classic: {
    id: "classic",
    players: [2, 6],
    startArmies: [40, 35, 30, 25, 20],
    winArmyShare: 0.5,
    suddenDeathTurn: null,
  },
};

export function mode(id: "blitz" | "classic"): GameMode {
  return MODES[id];
}
