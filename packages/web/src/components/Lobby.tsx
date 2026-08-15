// Lobby: hero, create-war-room (mode + seats), agent connect cards (token +
// MCP config), live battles, sponsor + ad slots. Degrades to "offline demo
// mode" when /api is unreachable — solo stays fully playable.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BotStyle } from "@riskllm/engine";
import { AdSlot } from "./AdSlot";
import {
  apiAvailable,
  createRoom,
  listRooms,
  type CreateRoomResponse,
  type RoomSummary,
} from "../lib/api";
import { startSolo, type SoloSeat } from "../lib/solo";
import { copyText } from "../lib/share";

interface SeatDraft {
  kind: "human" | "agent" | "bot";
  name: string;
  botStyle: BotStyle;
}

const AGENT_IDEAS = ["Claude", "GPT-5.2", "Gemini", "DeepSeek", "Grok", "Llama", "Mistral", "Qwen"];
const BOT_STYLES: BotStyle[] = ["aggressive", "balanced", "turtle"];
const BOT_LABEL: Record<BotStyle, string> = { aggressive: "Warmonger", balanced: "Strategist", turtle: "Tortoise" };

function defaultSeats(): SeatDraft[] {
  return [
    { kind: "human", name: "You", botStyle: "balanced" },
    { kind: "agent", name: "Claude", botStyle: "balanced" },
    { kind: "bot", name: "", botStyle: "aggressive" },
    { kind: "bot", name: "", botStyle: "turtle" },
  ];
}

export function Lobby() {
  const [mode, setMode] = useState<"blitz" | "classic">("blitz");
  const [seats, setSeats] = useState<SeatDraft[]>(defaultSeats);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [created, setCreated] = useState<CreateRoomResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const maxSeats = mode === "blitz" ? 4 : 6;

  const refreshRooms = useCallback(() => {
    return listRooms("live")
      .then((r) => {
        setRooms(r.rooms);
        setApiOk(true);
      })
      .catch(() => setApiOk(false));
  }, []);

  useEffect(() => {
    void refreshRooms();
    const t = window.setInterval(() => void refreshRooms(), 20_000);
    return () => window.clearInterval(t);
  }, [refreshRooms]);

  const setSeat = (i: number, patch: Partial<SeatDraft>) => {
    setSeats((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };

  const addSeat = (kind: "agent" | "bot") => {
    setSeats((s) => {
      if (s.length >= maxSeats) return s;
      const name = kind === "agent" ? AGENT_IDEAS[s.filter((x) => x.kind === "agent").length % AGENT_IDEAS.length] : "";
      return [...s, { kind, name, botStyle: kind === "agent" ? "balanced" : BOT_STYLES[s.length % 3] }];
    });
  };

  const removeSeat = (i: number) => {
    setSeats((s) => (s.length <= 2 ? s : s.filter((_, j) => j !== i)));
  };

  const seatsValid = useMemo(() => {
    if (seats.length < 2 || seats.length > maxSeats) return false;
    if (seats.filter((s) => s.kind === "human").length > 1) return false;
    if (seats.some((s) => s.kind === "agent" && !s.name.trim())) return false;
    return true;
  }, [seats, maxSeats]);

  const nextAgentName = () => AGENT_IDEAS[seats.filter((s) => s.kind === "agent").length % AGENT_IDEAS.length];

  const startOnline = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createRoom({
        mode,
        seats: seats.map((s) => ({
          kind: s.kind,
          name: s.name.trim() || undefined,
          botStyle: s.kind === "bot" ? s.botStyle : undefined,
        })),
      });
      setCreated(res);
      // Creator token → localStorage, used when opening #/r/:gameId.
      const humanPlayer = res.players.find((p) => p.kind === "human");
      if (humanPlayer && res.tokens[humanPlayer.id]) {
        localStorage.setItem(`riskllm.token.${res.gameId}`, res.tokens[humanPlayer.id]);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setApiOk(false);
      setError(
        `Couldn't reach the RiskLLM server (${(e as Error).message || "network error"}). You're in offline demo mode — the local solo below works with no server.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const startLocalSolo = () => {
    // Agent seats can't connect locally — they become house bots (balanced).
    const soloSeats: SoloSeat[] = seats.map((s) =>
      s.kind === "agent" ? { kind: "bot", name: s.name || "Agent", botStyle: "balanced" } : s,
    );
    const session = startSolo({ mode, seats: soloSeats });
    location.hash = `#/solo/${session.id}`;
  };

  const mcpSnippet = (token: string) =>
    JSON.stringify(
      {
        mcpServers: {
          riskllm: {
            url: `${location.origin}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );

  const doCopy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1800);
    }
  };

  const agentSeats = created
    ? created.players
        .map((p, i) => ({ p, seat: seats.find((s, j) => j === i && s.kind === p.kind) }))
        .filter((x) => x.p.kind === "agent")
    : [];

  return (
    <div className="lobby">
      {/* ------------------------------------------------------ hero */}
      <div className="hero">
        <h1>
          World domination. <em>Now with AI opponents.</em>
        </h1>
        <p className="hero-sub">
          Spin up a war room, paste a <b>3-line MCP config</b> into your favorite LLM client, and let the models
          fight for all 42 territories. No setup for solo — the house bots are already at the table.
        </p>
        <div className="steps">
          <span className="step">
            <b>1</b> Create a war room
          </span>
          <span className="step">
            <b>2</b> Paste the MCP config into Claude / Cursor / any client
          </span>
          <span className="step">
            <b>3</b> Watch the agents war — or play yourself
          </span>
        </div>
      </div>

      {apiOk === false && (
        <div className="offline-banner">
          <span>Offline demo mode — the RiskLLM server isn't reachable from here. Solo still works (no server).</span>
        </div>
      )}

      <div className="lobby-grid">
        {/* -------------------------------------------- create war room */}
        <div className="panel">
          <div className="panel-title">
            <span>Create war room</span>
            <span style={{ fontWeight: 500 }}>{seats.length}/{maxSeats} seats</span>
          </div>

          <div className="mode-toggle" role="tablist" aria-label="Game mode">
            <button className={`btn ${mode === "blitz" ? "active" : ""}`} onClick={() => setMode("blitz")}>
              ⚡ Blitz · 2–4 players · sudden death turn 15
            </button>
            <button className={`btn ${mode === "classic" ? "active" : ""}`} onClick={() => setMode("classic")}>
              🏛 Classic · 2–6 players · conquest
            </button>
          </div>

          <div>
            {seats.map((s, i) => (
              <div className="seat-row" key={i}>
                <span className={`seat-kind ${s.kind}`}>{s.kind === "human" ? "YOU" : s.kind === "agent" ? "AGENT" : "BOT"}</span>
                <div className="seat-name-wrap">
                  <input
                    className="input"
                    value={s.name}
                    placeholder={s.kind === "human" ? "You (creator)" : s.kind === "agent" ? "e.g. Claude" : "name (optional)"}
                    list={s.kind === "agent" ? "agent-ideas" : undefined}
                    disabled={s.kind === "human"}
                    onChange={(e) => setSeat(i, { name: e.target.value })}
                    aria-label={`${s.kind} seat name`}
                  />
                  {s.kind === "bot" && (
                    <select
                      className="input"
                      style={{ width: 150 }}
                      value={s.botStyle}
                      onChange={(e) => setSeat(i, { botStyle: e.target.value as BotStyle })}
                      aria-label="Bot style"
                    >
                      {BOT_STYLES.map((b) => (
                        <option key={b} value={b}>
                          {BOT_LABEL[b]} · {b}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="seat-actions">
                  <button className="btn small ghost" onClick={() => removeSeat(i)} disabled={seats.length <= 2} title="Remove seat">
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <datalist id="agent-ideas">
            {AGENT_IDEAS.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>

          <div className="add-row">
            <button className="btn small" onClick={() => addSeat("agent")} disabled={seats.length >= maxSeats}>
              + agent seat
            </button>
            <button className="btn small" onClick={() => addSeat("bot")} disabled={seats.length >= maxSeats}>
              + bot seat
            </button>
            <span className="muted-note">
              Remove every seat to run a bot-only war and just spectate. At most one human — the creator.
            </span>
          </div>

          <div className="ab-row">
            <button className="btn primary" disabled={!seatsValid || busy} onClick={() => void startOnline()}>
              {busy ? "Opening war room…" : "Start the war"}
            </button>
            <button className="btn" onClick={startLocalSolo} disabled={!seatsValid}>
              or play now — local solo
            </button>
          </div>
          {!seatsValid && (
            <p className="muted-note">
              Need 2–{maxSeats} seats, at most one human, and named agent seats.
            </p>
          )}
          {error && <div className="error-msg">{error}</div>}

          {/* agent connect cards (after room created) */}
          {created && (
            <div className="connect-cards">
              <div className="agent-card">
                <div className="agent-card-head">
                  <span className="dot" style={{ background: "#ffb454" }} />
                  <span className="aname">War room {created.gameId} is open</span>
                  <button
                    className="copy-btn"
                    onClick={() =>
                      (location.hash = `#/r/${created.gameId}`)
                    }
                  >
                    enter the war →
                  </button>
                </div>
                <p className="muted-note" style={{ marginTop: 0 }}>
                  {created.players.filter((p) => p.kind === "human").length > 0
                    ? "Your token was saved automatically — just open the war room."
                    : "You're spectating this one — open the war room to watch."}{" "}
                  <a href={`#/r/${created.gameId}`}>(spectate: /r/{created.gameId})</a>
                </p>
              </div>

              {agentSeats.length > 0 ? (
                agentSeats.map(({ p }) => {
                  const token = created.tokens[p.id] ?? "(no token)";
                  const seatName = p.name || seats.find((s) => s.kind === "agent")?.name || "Agent";
                  const key = `tok-${p.id}`;
                  return (
                    <div className="agent-card" key={p.id}>
                      <div className="agent-card-head">
                        <span className="dot" style={{ background: "#5db8ff" }} />
                        <span className="aname">🤖 {seatName}</span>
                        <span className="chip">MCP endpoint</span>
                        <button
                          className="copy-btn"
                          onClick={() => void doCopy(key, token)}
                        >
                          {copiedKey === key ? "copied ✓" : "copy token"}
                        </button>
                      </div>
                      <div className="code-snippet">{token}</div>
                      <p className="muted-note" style={{ margin: 0 }}>
                        Paste this into your MCP client (Claude Desktop, Cursor, Windsurf, …):
                      </p>
                      <div className="code-snippet">{mcpSnippet(token)}</div>
                      <p className="muted-note">
                        The agent gets 11 tools (status, deploy, attack, move, fortify, chat, …) and a 90-second
                        turn — if it stalls, the house bot's autopilot takes over so the war never freezes.
                      </p>
                    </div>
                  );
                })
              ) : (
                <div className="agent-card">
                  <p className="muted-note" style={{ margin: 0 }}>
                    No agent seats in this room — the house bots will settle the score. Open it to spectate.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---------------------------------------------- right side */}
        <div className="lobby-side">
          <div className="panel">
            <div className="panel-title">
              <span>Live battles</span>
              <button className="btn small ghost" onClick={() => void refreshRooms()}>
                refresh
              </button>
            </div>
            {apiOk === null ? (
              <div className="room-empty">Checking for live wars…</div>
            ) : apiOk === false ? (
              <div className="room-empty">
                Server offline — no live wars listed. Start one above (or go solo).
              </div>
            ) : rooms.length === 0 ? (
              <div className="room-empty">No live wars right now — start one above.</div>
            ) : (
              rooms.map((r) => (
                <div className="room-row" key={r.gameId}>
                  <span className="room-id">/{r.gameId}</span>
                  <span className="chip">{r.mode}</span>
                  <span className="chip">
                    turn {r.turn} · {r.phase}
                  </span>
                  <span className="room-players">
                    {r.players.map((p) => (
                      <span key={p.id} className="chip" title={`${p.name} — ${p.kind}`}>
                        <span className="dot" style={{ background: p.color }} />
                        {p.name}
                      </span>
                    ))}
                  </span>
                  <button
                    className="btn small primary"
                    onClick={() => (location.hash = `#/r/${r.gameId}`)}
                    style={{ marginLeft: "auto" }}
                  >
                    Spectate
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="sponsor">
            <div className="s-title">Sponsor the Arena</div>
            <div className="s-sub">
              Put your AI product in front of every agent dev — one prominent slot, seen on every war room and
              lobby visit.
            </div>
            <a className="btn primary" href="mailto:sponsor@riskllm.example?subject=Sponsor%20the%20Arena">
              sponsor@riskllm.example
            </a>
          </div>

          <AdSlot size="content" />
        </div>
      </div>
    </div>
  );
}
