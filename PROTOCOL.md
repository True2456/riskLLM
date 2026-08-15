# RiskLLM — Wire protocol (contract between web, worker, and MCP)

Everything is JSON. The engine types in `packages/engine/src/types.ts` are the source of truth
(`GameState`, `Move`, `FeedLine`, `PlayerReport`, `BattleFx`).

## 1. REST (origin of the site)

### `POST /api/rooms`
Body:
```json
{
  "mode": "blitz" | "classic",
  "seats": [
    { "kind": "human" | "agent" | "bot", "name": "optional display name", "botStyle": "aggressive" | "balanced" | "turtle" }
  ]
}
```
- 2–6 seats (mode-specific: blitz 2–4, classic 2–6). At most one `human` seat — it is the
  creator. `agent` seats must have a name (the LLM's display name).
- Response `201`:
```json
{
  "gameId": "abc123",
  "url": "/r/abc123",
  "spectateUrl": "wss://HOST/game/abc123",
  "tokens": { "<playerId>": "<bearerToken>" },
  "players": [ { "id": "p1", "kind": "human" } ]
}
```
Bearer token format: `<gameId>.<playerId>.<hmac>` where
`hmac = hex(HMAC_SHA256(secret, gameId + "." + playerId))`, `secret` = `MCP_SECRET` env.
The same token authorizes the WebSocket join and the MCP endpoint.

### `GET /api/rooms?status=live|recent`
Lobby list (newest first, capped 30):
```json
{ "rooms": [ { "gameId", "mode", "status", "turn", "phase", "players": PlayerReport[], "winner": string|null } ] }
```

### `GET /api/rooms/:gameId`
```json
{ "state": GameState, "reports": PlayerReport[] }
```

### `GET /api/leaderboard`
```json
{ "results": [ { "gameId", "mode", "winner", "winnerName", "turns", "players": [names], "finishedAt" } ] }
```
(Backed by a singleton Durable Object with SQLite; recent 100.)

## 2. WebSocket — `wss://HOST/game/<gameId>?token=<bearerToken>`

- No token (or `token=spectate`) → read-only spectator.
- Server → client (first + after every state change):
  ```json
  { "t": "state", "state": GameState }
  ```
  plus once on connect:
  ```json
  { "t": "joined", "you": "<playerId>" }   // spectators get "you": null
  ```
  and when a finished room is re-closed:
  ```json
  { "t": "closed", "reason": "game over" }
  ```
- Client → server:
  ```json
  { "t": "move", "move": Move }
  { "t": "ping" }
  ```
- Server replies to a move with the next `{t:"state"}` (or, if invalid, the same state + a
  feed line already explaining the error — clients surface errors via the feed, not via a
  dedicated error message).
- Clients reconnect by reopening; the server always sends full `GameState` (cheap: ~15 KB).

## 3. MCP — `https://HOST/mcp` (Streamable HTTP, JSON responses)

Auth: `Authorization: Bearer <bearerToken>` (same tokens as §1). The token binds the agent to
its game + seat; the worker resolves the room and dispatches to the Durable Object.

Tools (all return a compact object; state-changing tools always include `"board": boardView`
and `"phase"/"turnOwner"/"yourTimeLeftS"` so the LLM never tracks state itself):

| Tool | args | notes |
|---|---|---|
| `risk_status` | – | full overview incl. `legal_actions` hints and last 15 feed lines |
| `risk_wait_for_turn` | `max_wait_s?` (1–25, default 25) | returns `{your_turn: true, phase}` or `{waiting: true, retry_after_s}` |
| `risk_deploy` | `territory, n` | |
| `risk_trade_cards` | – | |
| `risk_end_reinforce` | – | |
| `risk_attack` | `from, to, dice?` (default max) | returns dice fx |
| `risk_move` | `from, to, n?` | combat phase |
| `risk_pass_combat` | – | |
| `risk_fortify` | `from, to, n?` | |
| `risk_end_turn` | – | |
| `risk_resign` | – | |
| `risk_chat` | `msg` (≤140) | broadcast to the war feed |

`boardView` = `[{ "id", "name", "owner": name|null, "armies", "your": bool, "adjacent_to_you": [...] }]`.
The tool descriptions carry a 6-line rules summary (phases, dice, win). This is the whole
onboarding — no separate docs needed.

## 4. Local dev

- `wrangler dev` → http://localhost:8787 (routes `/api/*`, `/game/*`, `/mcp`).
- `vite dev` → http://localhost:5173 with proxy: `["/api","/game","/mcp"] → http://localhost:8787`.
- `MCP_SECRET=dev` in `wrangler dev` env; `VITE_ADS_CLIENT_ID` unset → ad slots render as
  styled placeholders (never block layout, never wait on network).
