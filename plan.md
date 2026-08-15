# RiskLLM — Plan

**Risk-style world domination where your opponents are LLMs.**
One repo, two free Cloudflare services, one goal: **$0 hosting, ad-funded income, viral "my agent beat your agent" loop.**

---

## 1. Vision & core loop

- Human opens the site → sees a world map.
- **Solo:** play vs built-in house bots instantly (no setup).
- **Online:** create a room → fill agent slots → each slot gets an **MCP endpoint + token**.
  The owner pastes a 3-line MCP config into Claude Desktop / Cursor / any MCP client.
  The LLM now commands that country: it gets board state, waits for its turn, makes moves.
- **Agent vs Agent:** rooms with 0 humans — spectator mode. This is the traffic (and ad) engine:
  "Watch GPT-5.2 crush Claude in Risk" is shareable, embeddable, SEO-able.
- Post-game: scoreboard + a one-link share ("My agent beat yours: rllm.app/r/xyz").

**Why this can win:** every other "LLM plays X" demo is a screenshot. Here the agent is a
first-class player with a live, inspectable, replayable body on a real board — and connecting
one takes 60 seconds because the MCP server is hosted for us.

---

## 2. Business model (honest numbers)

| Stream | When | Notes |
|---|---|---|
| **Google AdSense** (primary) | after approval | Needs custom domain (~$10/yr) + original content + trust pages. Display RPM on a small dev site: ~$2–15. Early: pennies; if the agent-vs-agent spectacle takes off, real money. |
| **Sponsor slot (Carbon-style)** | day one | "Sponsor the Arena — $50/mo" for dev audiences (AI tooling, hosting, API startups). No approval wait. Highest CPM of the lot. |
| **Live-battle ad inventory** | day one | Spectator rooms = pageviews with long dwell time = better ad fills. |
| v2: paid badges / tournament brackets / custom agent skins | later | Only after traffic proves out. |

Content strategy (doubles as AdSense approval fuel + SEO): a `/guides` section with
original articles — "Connect Claude to a live Risk game", "How I built an LLM arena on free
Cloudflare", "Agent post-mortems of famous battles" (auto-generated from game logs!). The
post-mortem generator is cheap: the engine already writes a full action log.

**Costs: $0** (Cloudflare free tier covers everything) + ~$10/yr domain + optional ~$15/yr
for a prettier domain.

---

## 3. Architecture

```
                GitHub repo (source of truth)
                 │ git push
   ┌─────────────┴──────────────┐
   ▼                            ▼
Cloudflare PAGES (free)      Cloudflare WORKERS (free)
  static frontend (Vite)       routes: /mcp/*  /game/*  /api/*
  lobby, map UI, ads            │
   │  WebSocket + REST          ▼
   └──────────────►  Durable Object `GameRoom` (per game, free DO)
                         ├─ authoritative engine (same TS package as web)
                         ├─ humans via WebSocket (token auth)
                         ├─ agents via MCP (stateless /mcp, per-request token → dispatchFetch to room)
                         ├─ house bots (heuristic AI, same process)
                         └─ turn scheduler w/ per-player deadlines + auto-moves
```

- **One engine, three consumers:** `packages/engine` (pure TS, zero deps) is compiled into
  the web bundle (solo games + client projection) and the Worker (authoritative server).
- **MCP = stateless per-request** (`@modelcontextprotocol/sdk` `WebStandardStreamableHTTPServerTransport`
  with `enableJsonResponse`). Each tool call carries `Authorization: Bearer <player-token>`;
  the handler resolves the room via `env.GAME.get(idFromName(gameId)).fetch(...)`.
  `wait_for_turn` long-polls ≤ 25 s and returns `{waiting:true}` for the agent to retry —
  works with any MCP client, no SSE assumptions.
- **Free-tier fit (verified 2026):** Workers free = 100k req/day, 10 ms CPU/req (our turns
  are event-driven and trivial — no issue). DO free = SQLite-backed, 5 GB/account, unlimited
  objects, WebSocket-capable. Pages free = 500 builds/mo, 20 min build timeout, GitHub
  integration. A 6-player game = a handful of requests/minute. We are 100x under the limits.

### Repo layout

```
riskLLM/
  plan.md  README.md  AGENT.md (MCP onboarding)  MONETIZATION.md
  package.json               # npm workspaces
  packages/engine/           # board, rules, game loop, bots, rng, types
    src/{board.ts,types.ts,rng.ts,game.ts,bot.ts,index.ts}   test/*.test.ts
  packages/web/              # Vite + React UI
    src/{App,Lobby,GameView,MapCanvas,SidePanel,AgentSetup,Guides,...}.tsx
    src/assets/land.geojson  # Natural Earth 110m (public domain)
  packages/worker/           # Cloudflare Worker + DO + MCP
    src/{index.ts,room.ts,mcp.ts}   wrangler.toml
  scripts/                   # e2e MCP client test, ad-check, etc.
  .github/workflows/deploy.yml
```

---

## 4. Game design

**Board:** the classic 42-territory Risk map (Lux-classic variant naming: Western Canada,
Northern Europe, Ural, Yakutsk, Irkutsk, Kamchatka, Siam, … — 83 routes). One map for all
modes (less code, one map to tune visually). Data source: verified 42-node adjacency JSON.
Nodes placed at geographic centroids over a real Natural-Earth land outline (equirectangular).

**Modes**
| | **Blitz** (default) | **Classic** |
|---|---|---|
| Players | 2–4 | 2–6 |
| Start armies | 25 / 20 / 16 | 40 / 35 / 30 / 25 / 20 |
| Reinforcements | max(3, ⌈terr/3⌉) + continent bonus | same |
| Win | 30% of all armies, elimination, or sudden death turn 15 (most armies) | conquest or 50% of armies |
| Cards | 1/turn if you conquered; 3 → +5 | same |
| Expected length | 10–20 min w/ agents | 40–90 min |

**Turn = Reinforce → Combat → Fortify.** Actions (all idempotent, server-validated):
`deploy(t,n)`, `trade_cards()`, `end_reinforce()`, `attack(from,to,dice)`, `move(from,to,n)`,
`pass_combat()`, `fortify(from,to,n)` (path through own territory, ≤3), `end_turn()`, `resign()`.
Combat: classic dice (attacker ≤3, defender ≤2, defender wins ties; 3v2 74%, 2v2 52.5%, 1v1 42%).
**Turn deadlines:** agent 90 s, human 60 s; on expiry the house-bot brain auto-plays (games
never stall — critical for the spectator experience).

**House bots (3 difficulty tiers):** heuristic value-of-action scoring with precomputed
capture-probability tables; "aggressive / balanced / turtle" personas for variety.
These make solo play work with zero setup and keep agent-only rooms full.

**Spectator feed:** every action → timestamped "war feed" line ("Claude Sonnet: 3→2 armies on
Quebec, conquest!"). Doubles as content for the auto post-mortems.

---

## 5. MCP surface (what the agent's LLM sees)

Endpoint: `https://<domain>/mcp` (Streamable HTTP, bearer token per player seat).
Tools:

| Tool | Args | Returns |
|---|---|---|
| `risk_status` | — | game id, phase, turn owner, turn timer, mode, full board (owner + armies per territory), your stats, legal actions, last 15 feed lines |
| `risk_wait_for_turn` | `max_wait_s` (≤25) | either "your turn, phase X, do it" or `{waiting:true, retry_after_s}` |
| `risk_deploy` | `territory, n` | result + new state |
| `risk_trade_cards` | — | result |
| `risk_end_reinforce` | — | result |
| `risk_attack` | `from, to, dice(1-3)` | dice rolls, casualties, conquest? + new state |
| `risk_move` | `from, to, n` | result |
| `risk_pass_combat` | — | result |
| `risk_fortify` | `from, to, n` | result |
| `risk_end_turn` | — | result |
| `risk_resign` | — | result |
| `risk_chat` | `msg` (≤140 chars, broadcast) | ok | (diplomacy! agents lie to each other)

Every state-changing tool returns a compact **delta + full board** so the LLM never has to
track state itself. System-prompt blurb + `risk_status` description carry the rules.

---

## 6. Hosting & deployment (all free)

1. `gh repo create True2456/riskLLM --public`, push.
2. **Pages:** connect repo → build `npm ci && npm run build -w web` → output `packages/web/dist`.
3. **Worker:** deploy `packages/worker` (wrangler via GitHub Actions secret `CLOUDFLARE_API_TOKEN`,
   or Workers Builds). Routes: `DOMAIN/mcp/*`, `DOMAIN/game/*`, `DOMAIN/api/*`.
4. Custom domain (required for AdSense; `pages.dev`/`workers.dev` subdomains won't get approved):
   buy ~$10/yr, add CNAME, CF auto-SSL.
5. `/ads.txt` once approved; ad slot IDs via env (`ADS_CLIENT_ID`) so local dev never blocks.

Deploy is **not** in my hands without a CF token — Phase 7 writes exact steps + CI, and I
execute it if a token is provided.

---

## 7. Visual design bar (I will screenshot-verify every phase)

- Dark "war room" theme: near-black blue background, continent fills in desaturated teal/slate,
  territories = glowing player-colored nodes sized by army count, thin amber route lines,
  red battle-flash animation on captures, subtle graticule grid.
- Left: map (dominant, ≥65% width). Right: war feed + player stack + phase banner + ad slot
  (ads NEVER cover the board). Bottom: action bar / agent-status chips (with ⏱ countdown per
  pending agent — suspense UI).
- Lobby: big "Create war room", live-battles list with spectate buttons, agent connect cards
  (token + MCP config snippet, copy button), sponsor slot.
- Mobile: playable (map scales, panel becomes a bottom sheet). AdSense = mobile-ready site.
- Accessibility: keyboard-selectable territories, aria-live feed.

---

## 8. Build phases

- [x] **P0 — Research & plan** (CF free tiers, MCP-on-Workers, ads, 42-territory data) ← this doc
- [x] **P1 — Engine** (`packages/engine`): board data (42 territories, 83 routes, verified), types,
      rng, Game class (phases, canonical dice — exact-match test vs published tables, cards,
      continents, win/sudden-death, feed), bots ×3 (doctrine-based: 2d vs 1, 3d vs 2, chip),
      17/17 vitest green, tsc clean. Key bugs found+fixed: turn-1 share-win, dice roll not ending
      on capture, bot move ping-pong. `PROTOCOL.md` written as the web/worker/MCP contract.
      *Owner: me*
- [x] **P2 — Web UI** (`packages/web`): Vite+React, map canvas (land + glowing nodes sized by
      armies + routes + battle flash), lobby, game view, action bar, agent chips, war feed, ad
      slots, guides/trust pages, mobile pass. Build green (343 kB / 114 kB gzip). *Owner: Herdr
      sibling (pi) then main agent* — sibling built the ~1800-line UI; main agent fixed the
      workspace build script + 5 type errors, then re-styled the map to the §7 bar (glow, bigger
      radius, readable land/routes, label declutter) after screenshot review.
- [x] **P3 — Worker** (`packages/worker`): wrangler config, GameRoom DO (state, WS, scheduler,
      auto-moves, persistence), Board DO (SQLite room registry + leaderboard), `/api` (room
      create/list/status, leaderboard), `/mcp` (12 tools, token auth, long-poll wait). tsc clean.
      **Live-verified on miniflare**: room create → tokens → MCP initialize/tools-list/risk_status/
      risk_wait_for_turn all green; all-bot room plays itself to completion via alarms. *Owner: me*
- [x] **P4 — Integration & e2e**: `scripts/e2e-agent.ts` — MCP client plays a FULL game vs
      house bots (74 tool calls to a win; raw state via REST, every action through /mcp).
      `scripts/e2e-ws.ts` — human join (token), deploy delta, spectator (you=null),
      invalid move surfaced via feed. Room state survives worker restart (DO/SQLite persist —
      "the war continues"). *Owner: me*
- [x] **P5 — Visual QA loop**: browser-CDP screenshots (desktop + 390×844 mobile) of lobby,
      live game, game-over overlay, mobile game + mobile lobby. Fixed: map nodes too small / no
      glow, land + routes too faint, label clutter, noisy war feed ("auto-pilot takes command" per
      move → once per turn), Board DO `toArray()` returned objects not tuples (rooms API 500).
      *Owner: me*
- [x] **P4b — Real LLM in the game**: `scripts/llm-agent.ts` drives **NVIDIA Nemotron 3.5
      Lightning (free, via OpenRouter)** as the p1 seat using ONLY the 12 MCP tools (function
      calling). It played a full blitz and **won** ("held 50% of all armies", turn 4) — proving a
      real external LLM can command a country end-to-end over MCP. *Owner: me*
- [ ] **P6 — Content & money**: README, AGENT.md, MONETIZATION.md, guides (4+ original articles
      incl. auto post-mortem template), trust pages, ads.txt, sponsor slot, CI deploy.
      *Owner: Herdr sibling (pi, medium thinking) + me*
- [ ] **P7 — Ship**: git push, Pages + Worker deploy (needs CF token), live smoke,
      AdSense application checklist. *Owner: me + user*

**Progress log**
- 2026-08-15: P0 done. CF free tiers verified (Workers 100k req/day + free SQLite DO; Pages
  500 builds/mo). MCP stateless-per-request pattern confirmed. 42-territory adjacency data
  captured. Plan written.
- 2026-08-15: P1 done. Engine + tests (17/17) + typecheck green. Dice rules proven exact vs
  canonical tables (1v1 42/58, 2v1 58/42, 3v1 66/34, 2v2 23/32/45, 3v2 37/34/29). PROTOCOL.md
  (WS/REST/MCP contract) written. Frontend delegated to Herdr sibling (pi, high thinking);
  worker being built in parallel by main agent.
- 2026-08-15: P3 done. Worker + GameRoom DO + Board DO (SQLite) + MCP server on stateless
  Streamable HTTP. Verified live on miniflare: POST /api/rooms → per-seat HMAC tokens; MCP
  initialize → tools/list (12 tools) → risk_status (full board) → risk_wait_for_turn all green;
  3-bot room self-played to a win through the alarm loop. Fixed en route: 2026 workers-types
  (DO stubs via namespace.get(), storage.setAlarm, SQLite DO needs new_sqlite_classes migration),
  MCP SDK import paths + Zod tool schemas, win-share pacing (3p 45%→50%, 4p 35%→40% — first bot
  game was ending turn 4).
- 2026-08-15: P4 done. Full e2e green: (1) MCP client plays a complete blitz to a win
  (51→74 tool calls, winner + feed recorded); (2) WS human join → deploy delta 1→3 on Alaska →
  spectator join (you=null) → illegal attack surfaces as feed line "⚠ combat phase only"
  (found + fixed a protocol gap: the WS path was silently dropping rejected moves, now shares
  applyMove with the MCP path per PROTOCOL.md §2); (3) room state survives a full worker restart
  (miniflare DO/SQLite persistence). Pacing re-tuned from observed bot games: share wins need a
  turn ≥ 4 gate + 55/50/45 thresholds (2p/3p/4p) — turn-3 wins by reinforcement volume were
  killing game length.
- 2026-08-15: **Real LLM in the game (P4b).** Wired `scripts/llm-agent.ts` to OpenRouter
  `nvidia/nemotron-3.5-lightning:free` (user-provided key) as the p1 seat, using ONLY the 12 MCP
  tools via function calling. Nemotron played a full blitz and **won** ("held 50% of all armies",
  turn 4, 5.5 min) — the core product claim ("a real LLM commands a country over MCP") is now
  proven live. Added name→id territory normalization at the MCP layer (LLMs pass "Alaska" not
  "ALA") and `winReason` to the MCP status.
- 2026-08-15: **Web UI finished + visual QA (P2/P5).** Took over the web build from the
  (unstable local-model) Herdr sibling: fixed the root workspace script (`-w web` → the package
  is `@riskllm/web`) and 5 type errors (land.geojson `?raw` import, 127-polygon `number[][][][]`
  cast, MapCanvas null-narrowing). Screenshot-verified lobby + live game + game-over overlay +
  mobile (390×844) game and lobby via CDP. Re-styled the map to the §7 bar: glowing player-color
  nodes (drop-shadow), radius 8→21 by army count, brighter land/routes, name labels only on
  hover/selection. Fixed a war-feed noise bug ("auto-pilot takes command" was pushed per move,
  now once per turn) and a Board DO bug (`toArray()` returns column-keyed objects, not tuples —
  rooms API was 500ing). Full build 343 kB / 114 kB gzip; 17/17 tests; worker + web typecheck
  green.
- 2026-08-15: **Free-tier re-verified + hibernation fix.** Re-checked Cloudflare pricing
  (2026): Workers Free = 100k req/day; DO Free = 100k req/day (WS messages billed 20:1) +
  13,000 GB-s/day duration + SQLite-backed DOs only (which is exactly what we use); Pages Free
  = 500 builds/mo. Found our room DO used plain `server.accept()`, which bills duration for the
  whole time a client tab is open (128 MB × wall-clock) — a spectator-heavy room could chew the
  13k GB-s allowance. Switched to the hibernation WebSocket API: `state.acceptWebSocket(server)`
  (DO sleeps while clients stay connected, wakes on message/alarm; constructor re-runs and
  `init()` rehydrates the game from SQLite), per-connection seat ownership carried in
  `serializeAttachment` (≤16 KB), broadcast via `state.getWebSockets()`. Re-verified with
  e2e-ws (join/move/spectator/invalid-move) + full e2e-agent game to completion. Idle spectator
  time is now ~$0; only real work (bot moves, move validation, pongs) bills, and a full blitz
  costs well under 1 GB-s.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent stalls a live game (LLM slow/looping) | 90 s deadline → house-bot auto-play; `wait_for_turn` capped at 25 s; agent turn timer visible to spectators (fun, not sad) |
| 10 ms CPU/req on Workers free | engine steps are microsecond-scale event handlers; no polling loops in DO; all waits are alarms/websockets |
| AdSense rejection (new site, game site) | original guides + trust pages + custom domain + slow-and-steady: apply after 4–6 real articles & game logs; instant-approval fallbacks (Carbon/Monetag) meanwhile |
| DO eviction mid-game | DO snapshots + full state in SQLite; wake-on-WS-reconnect; game is resumable — feature, not bug ("the war continues") |
| Cheating via MCP | server validates every move (ownership, adjacency, phase, counts); tokens are per-seat; nothing client-sent is trusted |
| Hasbro trademark on "Risk" | game concept/genre is fine; brand as RiskLLM (nominative) + README disclaimer; map naming already uses Lux-classic variant names |
| Scope creep | v1 = one map, two modes, no cards-in-cards, no lobbies-of-lobbies. Everything else is v2 notes at bottom |

**v2 backlog (NOT now):** custom map builder, secret-mission variant, ranked seasons + ELO,
per-agent leaderboards with model/labels, live "agent of the week", rematch brackets,
web-chat-alliance UI, mobile app shell, i18n.
