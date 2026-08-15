// Small REST client for /api/* (PROTOCOL.md §1). All calls time out after 6s.

export interface RoomPlayer {
  id: string;
  name: string;
  kind: "human" | "agent" | "bot";
  color: string;
  territories: number;
  armies: number;
  alive: boolean;
  isTurn: boolean;
}

export interface RoomSummary {
  gameId: string;
  mode: string;
  status: string;
  turn: number;
  phase: string;
  players: RoomPlayer[];
  winner: string | null;
}

export interface CreateRoomResponse {
  gameId: string;
  url: string;
  spectateUrl: string;
  tokens: Record<string, string>;
  players: { id: string; kind: "human" | "agent" | "bot"; name?: string }[];
}

export interface SeatSpec {
  kind: "human" | "agent" | "bot";
  name?: string;
  botStyle?: "aggressive" | "balanced" | "turtle";
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function apiAvailable(): Promise<boolean> {
  return jfetch<{ rooms: unknown[] }>("/api/rooms?status=live").then(
    () => true,
    () => false,
  );
}

export function createRoom(body: { mode: "blitz" | "classic"; seats: SeatSpec[] }): Promise<CreateRoomResponse> {
  return jfetch<CreateRoomResponse>("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listRooms(status: "live" | "recent"): Promise<{ rooms: RoomSummary[] }> {
  return jfetch<{ rooms: RoomSummary[] }>(`/api/rooms?status=${status}`);
}
