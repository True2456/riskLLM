// WebSocket client for /game/<gameId> (PROTOCOL.md §2).
// Spectators pass token=null. Reconnects with exponential backoff; after 3
// consecutive failed attempts it reports "offline" so the UI can offer the
// solo fallback. A 20s ping loop keeps our lastSeen fresh on the server.

import type { GameState, Move } from "@riskllm/engine";

export type ConnStatus = "connecting" | "open" | "offline";

export interface OnlineCallbacks {
  onState(state: GameState): void;
  onJoined(you: string | null): void;
  onClosed(reason: string): void;
  onStatus(status: ConnStatus): void;
}

export interface OnlineGame {
  readonly status: ConnStatus;
  send(move: Move): void;
  dispose(): void;
}

export function connectGame(gameId: string, token: string | null, cb: OnlineCallbacks): OnlineGame {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/game/${encodeURIComponent(gameId)}?token=${encodeURIComponent(token ?? "spectate")}`;

  let ws: WebSocket | null = null;
  let disposed = false;
  let attempts = 0;
  let retryTimer: number | undefined;
  let pingTimer: number | undefined;
  let status: ConnStatus = "connecting";

  const setStatus = (s: ConnStatus) => {
    if (status === s) return;
    status = s;
    cb.onStatus(s);
  };

  const clearTimers = () => {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    if (pingTimer !== undefined) window.clearInterval(pingTimer);
    retryTimer = pingTimer = undefined;
  };

  const open = () => {
    if (disposed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      attempts = 0;
      setStatus("open");
      pingTimer = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" }));
      }, 20_000);
    };
    ws.onmessage = (ev) => {
      let msg: { t?: string; state?: GameState; you?: string | null; reason?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "state" && msg.state) cb.onState(msg.state);
      else if (msg.t === "joined") cb.onJoined(msg.you ?? null);
      else if (msg.t === "closed") cb.onClosed(msg.reason ?? "game over");
    };
    ws.onclose = () => {
      if (pingTimer !== undefined) window.clearInterval(pingTimer);
      pingTimer = undefined;
      if (disposed) return;
      scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  };

  const scheduleRetry = () => {
    attempts += 1;
    if (attempts >= 3) setStatus("offline");
    const delay = Math.min(10_000, 700 * 2 ** Math.min(attempts - 1, 4));
    retryTimer = window.setTimeout(open, delay);
  };

  open();

  return {
    get status() {
      return status;
    },
    send(move: Move) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "move", move }));
    },
    dispose() {
      disposed = true;
      clearTimers();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
