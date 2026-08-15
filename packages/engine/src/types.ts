export type Phase = "reinforce" | "combat" | "fortify";
export type GameStatus = "running" | "over";
export type PlayerKind = "human" | "agent" | "bot";
export type BotStyle = "aggressive" | "balanced" | "turtle";
export type CardSymbol = "infantry" | "cavalry" | "artillery";
export type ModeId = "blitz" | "classic";

export interface PlayerSpec {
  id: string;
  name: string;
  kind: PlayerKind;
  botStyle?: BotStyle;
  color?: string;
}

export interface PlayerState {
  id: string;
  name: string;
  kind: PlayerKind;
  color: string;
  botStyle: BotStyle | null;
  cards: CardSymbol[];
  eliminated: boolean;
  // last time we saw activity from this player (for the UI "online" chip)
  lastSeenMs: number;
}

export interface TerritoryState {
  owner: string | null;
  armies: number;
}

export type Move =
  | { t: "deploy"; territory: string; n: number }
  | { t: "trade_cards" }
  | { t: "end_reinforce" }
  | { t: "attack"; from: string; to: string; dice: number }
  | { t: "move"; from: string; to: string; n?: number }
  | { t: "pass_combat" }
  | { t: "fortify"; from: string; to: string; n?: number }
  | { t: "end_turn" }
  | { t: "resign" }
  | { t: "chat"; msg: string };

export type FeedKind =
  | "deploy"
  | "trade"
  | "attack"
  | "conquest"
  | "move"
  | "fortify"
  | "pass"
  | "turn"
  | "elim"
  | "chat"
  | "game"
  | "deadline";

export interface BattleFx {
  type: "battle";
  from: string;
  to: string;
  attRoll: number[];
  defRoll: number[];
  attLost: number;
  defLost: number;
  conquered: boolean;
}

export interface FeedLine {
  seq: number;
  turn: number;
  playerId: string | null;
  kind: FeedKind;
  text: string;
  ts: number;
  fx?: BattleFx;
}

export interface GameState {
  game: string;
  mode: ModeId;
  status: GameStatus;
  turn: number;
  phase: Phase;
  turnOwner: string | null;
  deadlineMs: number;
  territories: Record<string, TerritoryState>;
  players: PlayerState[];
  /** reinforcements the current player has not deployed yet */
  toReinforce: number;
  /** fortify moves remaining for the current player */
  fortifyMoves: number;
  cardsTradeable: boolean;
  winner: string | null;
  winReason: string | null;
  feed: FeedLine[];
  seed: number;
  rng: { s: number };
  /** territories claimed by each player this turn (for the 1-card-per-turn rule) */
  conqueredThisTurn: number;
  /** set once any territory changes hands; gates the army-share win check */
  firstConquest: boolean;
  nextSeq: number;
}

export interface MoveResult {
  ok: boolean;
  error?: string;
  state: GameState;
}

export interface PlayerReport {
  id: string;
  name: string;
  kind: PlayerKind;
  color: string;
  botStyle: BotStyle | null;
  cards: CardSymbol[];
  territories: number;
  armies: number;
  alive: boolean;
  isTurn: boolean;
  deadlineMs: number;
}

export const PLAYER_COLORS = [
  "#ff5d5d",
  "#5db8ff",
  "#ffd25d",
  "#7dff8a",
  "#c885ff",
  "#ff9d5d",
] as const;
