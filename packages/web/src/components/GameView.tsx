// Live game screen: map (left, ~68%) + phase banner / player stack / war feed
// / ads (right, ~32%), action bar + agent chips under the map.
// Works for online games (WS per PROTOCOL.md §2) and local solo games (engine
// in-browser, src/lib/solo.ts). Spectators pass no token.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TERRITORY_BY_ID,
  type CardSymbol,
  type FeedLine,
  type GameState,
  type Move,
  type PlayerKind,
  type PlayerReport,
} from "@riskllm/engine";
import { AdSlot } from "./AdSlot";
import { MapCanvas, type FxView } from "./MapCanvas";
import { connectGame, type ConnStatus } from "../lib/online";
import { getSolo, type SoloSession } from "../lib/solo";
import { buildShare, copyText } from "../lib/share";

const KIND_ICON: Record<PlayerKind, string> = { human: "🧑", agent: "🤖", bot: "🎲" };
const TURN_MS: Record<string, number> = { agent: 90_000, human: 60_000, bot: 1_000 };

interface Props {
  gameId: string;
  source: "solo" | "online";
}

function makeReports(s: GameState): PlayerReport[] {
  return s.players.map((p) => {
    let terr = 0;
    let arm = 0;
    for (const t of Object.values(s.territories)) {
      if (t.owner === p.id) {
        terr += 1;
        arm += t.armies;
      }
    }
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      color: p.color,
      botStyle: p.botStyle,
      cards: p.cards,
      territories: terr,
      armies: arm,
      alive: !p.eliminated,
      isTurn: p.id === s.turnOwner,
      deadlineMs: p.id === s.turnOwner ? s.deadlineMs : 0,
    };
  });
}

/* ------------------------------------------------------------- countdowns */

function useNow(active: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [active, everyMs]);
  return now;
}

function TurnTimer({ deadlineMs, totalMs }: { deadlineMs: number; totalMs: number }) {
  const now = useNow(deadlineMs > 0, 250);
  if (deadlineMs <= 0) return null;
  const remaining = Math.max(0, deadlineMs - now);
  const pct = Math.min(100, (remaining / totalMs) * 100);
  const color = pct > 50 ? "var(--green)" : pct > 20 ? "var(--accent)" : "var(--red)";
  return (
    <>
      <div className="timerbar">
        <div className="timerbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="ab-hint" style={{ margin: 0 }}>
        {Math.ceil(remaining / 1000)}s before auto-pilot takes the wheel
      </div>
    </>
  );
}

function AgentCountdown({ deadlineMs }: { deadlineMs: number }) {
  const now = useNow(deadlineMs > 0, 1000);
  const remaining = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
  if (remaining <= 0) return <span className="think">⏱ overdue — auto-pilot…</span>;
  return <span className="think">⏱ thinking… {remaining}s</span>;
}

/* ------------------------------------------------------------------- feed */

function WarFeed({ feed }: { feed: FeedLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeq = feed.length ? feed[feed.length - 1].seq : 0;

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastSeq]);

  return (
    <div
      className="war-feed"
      ref={ref}
      aria-live="polite"
      aria-label="War feed"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {feed.map((l) => (
        <div key={l.seq} className={`fl fl-${l.kind}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- game view */

export function GameView({ gameId, source }: Props) {
  const token = useMemo(
    () => (source === "online" ? localStorage.getItem(`riskllm.token.${gameId}`) ?? null : null),
    [gameId, source],
  );

  const [game, setGame] = useState<GameState | null>(null);
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [youId, setYouId] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnStatus>(source === "solo" ? "open" : "connecting");
  const [version, setVersion] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [tgt, setTgt] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [chatMsg, setChatMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [resignArm, setResignArm] = useState(false);
  const [soloMissing, setSoloMissing] = useState(false);

  const soloRef = useRef<SoloSession | null>(null);
  const ogRef = useRef<ReturnType<typeof connectGame> | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  // -------------------------------------------------------- game lifecycle
  useEffect(() => {
    if (source === "solo") {
      const s = getSolo(gameId);
      if (!s) {
        setSoloMissing(true);
        return;
      }
      soloRef.current = s;
      const sync = () => {
        setGame(s.game.state);
        setReports(s.game.reports());
        setVersion((v) => v + 1);
        setYouId((h) => h ?? s.game.state.players.find((p) => p.kind === "human")?.id ?? null);
      };
      sync();
      const unsub = s.subscribe(sync);
      return () => {
        unsub();
        soloRef.current = null;
      };
    }
    const og = connectGame(gameId, token, {
      onState: (st) => {
        setGame(st);
        setReports(makeReports(st));
        setVersion((v) => v + 1);
      },
      onJoined: (you) => setYouId(you),
      onClosed: () => {},
      onStatus: (s) => setConn(s),
    });
    ogRef.current = og;
    return () => {
      og.dispose();
      ogRef.current = null;
    };
  }, [gameId, source, token]);

  // Reset selection when the phase or turn owner changes.
  const prevPhase = useRef<{ phase?: string; owner?: string | null }>({});
  useEffect(() => {
    if (!game) return;
    const prev = prevPhase.current;
    if ((prev.phase && prev.phase !== game.phase) || (prev.owner !== undefined && prev.owner !== game.turnOwner)) {
      setSel(null);
      setTgt(null);
    }
    prevPhase.current = { phase: game.phase, owner: game.turnOwner };
  }, [game, version]);

  // Battle fx: only animate fresh battles (last 2s) — not stale feed history.
  const fx = useMemo<FxView | null>(() => {
    if (!game) return null;
    for (let i = game.feed.length - 1; i >= 0; i--) {
      const l = game.feed[i];
      if (l.fx) {
        if (Date.now() - l.ts > 2000) return null;
        return {
          seq: l.seq,
          from: l.fx.from,
          to: l.fx.to,
          attLost: l.fx.attLost,
          defLost: l.fx.defLost,
          conquered: l.fx.conquered,
        };
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, version]);

  // ------------------------------------------------------------- send moves
  const myTurn = game !== null && youId !== null && game.turnOwner === youId && game.status === "running";

  const send = useCallback(
    (move: Move) => {
      if (!game || game.status === "over") return;
      if (source === "solo") {
        const s = soloRef.current;
        if (!s) return;
        const res = s.applyAsHuman(move);
        if (!res.ok) {
          setFlash(res.error ?? "illegal move");
          window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
        } else {
          setFlash(null);
        }
      } else {
        ogRef.current?.send(move); // errors surface via the feed (protocol §2)
      }
      if (move.t === "attack" || move.t === "move" || move.t === "fortify" || move.t === "deploy") {
        setTgt(null);
      }
    },
    [game, source],
  );

  // -------------------------------------------------------------- onPick
  const onPick = useCallback(
    (id: string) => {
      if (!game || game.status === "over" || !youId) return;
      const t = game.territories[id];
      if (!t) return;
      if (t.owner === youId) {
        if (sel === id) {
          setSel(null);
          setTgt(null);
          return;
        }
        if (sel && (game.phase === "combat" || game.phase === "fortify")) {
          setTgt(id); // second own-territory pick = move/fortify destination
        } else {
          setSel(id);
          setTgt(null);
        }
      } else if (sel && game.phase === "combat") {
        setTgt(id);
      }
    },
    [game, youId, sel],
  );

  // -------------------------------------------------------------- keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!game || game.status === "over") return;
      if (e.key === "Escape") {
        setSel(null);
        setTgt(null);
        setResignArm(false);
        return;
      }
      if (!myTurn) return;
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        if (game.phase === "reinforce") {
          if (sel) send({ t: "deploy", territory: sel, n: Math.min(n, game.toReinforce) });
        } else if (game.phase === "combat") {
          if (!sel || !tgt) return;
          if (game.territories[tgt].owner === youId) send({ t: "move", from: sel, to: tgt, n });
          else send({ t: "attack", from: sel, to: tgt, dice: n });
        } else {
          if (sel && tgt) send({ t: "fortify", from: sel, to: tgt, n });
        }
      } else if (e.key === "Enter") {
        if (el && el.tagName === "BUTTON") return; // let focused buttons work
        if (game.phase === "reinforce") send({ t: "end_reinforce" });
        else if (game.phase === "combat") send({ t: "pass_combat" });
        else send({ t: "end_turn" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [game, myTurn, sel, tgt, youId, send]);

  // ------------------------------------------------------------------ view
  if (soloMissing) {
    return (
      <div className="page">
        <h1>That solo war is gone</h1>
        <p>
          Local games live in memory — a page refresh clears them. <a href="#/">Back to the lobby</a> and start a
          new one.
        </p>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="game-page">
        <div className="game-top">
          <a className="btn small" href="#/">
            ← lobby
          </a>
          <span className="gtitle">RiskLLM</span>
          <span className="gid">
            {gameId} · {source === "solo" ? "local" : source}
          </span>
        </div>
        <div className="page">
          <p>
            {source === "online" && conn === "offline"
              ? "Can't reach the server right now — trying to reconnect…"
              : "Connecting to the war room…"}
          </p>
        </div>
      </div>
    );
  }

  const owner = game.turnOwner ? game.players.find((p) => p.id === game.turnOwner) ?? null : null;
  const turnTotal = owner ? TURN_MS[owner.kind] ?? 60_000 : 60_000;
  const selName = sel ? TERRITORY_BY_ID[sel]?.name ?? sel : null;
  const tgtName = tgt ? TERRITORY_BY_ID[tgt]?.name ?? tgt : null;
  const tgtTerr = tgt ? game.territories[tgt] : null;
  const selTerr = sel ? game.territories[sel] : null;
  const me = youId ? game.players.find((p) => p.id === youId) ?? null : null;
  const agents = game.players.filter((p) => p.kind === "agent");

  const doShare = async () => {
    const { text } = buildShare(game);
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="game-page">
      {/* ------------------------------------------------ top bar */}
      <div className="game-top">
        <a className="btn small ghost" href="#/">
          ← lobby
        </a>
        <span className="gtitle">RiskLLM</span>
        <span className="chip">
          {game.mode} · turn {game.turn}
        </span>
        <span className="gid">{gameId}</span>
        <span className="spacer" />
        {source === "solo" ? (
          <span className="conn-badge open">● local solo</span>
        ) : (
          <span className={`conn-badge ${conn}`}>
            {conn === "open" ? "● live" : conn === "connecting" ? "● connecting" : "● reconnecting"}
          </span>
        )}
        {youId === null && <span className="chip">spectating</span>}
        {me && <span className="chip">you: {me.name}</span>}
      </div>

      {source === "online" && conn === "offline" && (
        <div className="offline-banner">
          <span>Offline demo mode — can't reach the RiskLLM server (reconnecting in the background).</span>
          <a className="btn small" href="#/">
            Play local solo instead
          </a>
        </div>
      )}

      {/* ------------------------------------------------ layout */}
      <div className="game-layout">
        <div className="game-left">
          <MapCanvas
            state={game}
            version={version}
            youId={youId}
            sel={sel}
            tgt={tgt}
            fx={fx}
            onPick={onPick}
          />

          {agents.length > 0 && (
            <div className="chips">
              {agents.map((a) => {
                const active = a.id === game.turnOwner && game.status === "running";
                return (
                  <span key={a.id} className={`chip agent-chip ${active ? "active" : ""}`}>
                    <span className="dot" style={{ background: a.color }} />
                    {a.name} {KIND_ICON.agent}
                    {active ? <AgentCountdown deadlineMs={game.deadlineMs} /> : <span className="stale">waiting</span>}
                  </span>
                );
              })}
            </div>
          )}

          {/* action bar */}
          <div className="action-bar">
            {game.status === "over" ? (
              <p className="ab-hint">The war is over — see the standings above.</p>
            ) : myTurn ? (
              game.phase === "reinforce" ? (
                <>
                  <div className="ab-target">
                    <b className="phase-name" style={{ display: "inline-block" }}>reinforce</b> · {game.toReinforce}{" "}
                    armies to deploy
                    {selName ? (
                      <>
                        {" "}— <span className="tn">{selName}</span>
                      </>
                    ) : (
                      " — pick one of your territories"
                    )}
                  </div>
                  <div className="ab-row">
                    <button
                      className="btn"
                      disabled={!sel || game.toReinforce < 1}
                      onClick={() => sel && send({ t: "deploy", territory: sel, n: 1 })}
                    >
                      Deploy 1 <span className="kbd">1</span>
                    </button>
                    <button
                      className="btn"
                      disabled={!sel || game.toReinforce < 1}
                      onClick={() => sel && send({ t: "deploy", territory: sel, n: 2 })}
                    >
                      Deploy 2 <span className="kbd">2</span>
                    </button>
                    <button
                      className="btn"
                      disabled={!sel || game.toReinforce < 1}
                      onClick={() => sel && send({ t: "deploy", territory: sel, n: game.toReinforce })}
                    >
                      Deploy all ({game.toReinforce})
                    </button>
                    {me && me.cards.length >= 3 && (
                      <button className="btn" onClick={() => send({ t: "trade_cards" })}>
                        Trade 3 cards → +5 armies
                      </button>
                    )}
                    <span className="spacer" />
                    <button className="btn primary" onClick={() => send({ t: "end_reinforce" })}>
                      End reinforce <span className="kbd">↵</span>
                    </button>
                  </div>
                  <p className="ab-hint">
                    Keys <span className="kbd">1</span>–<span className="kbd">9</span> deploy that many armies,{" "}
                    <span className="kbd">↵</span> ends the phase, <span className="kbd">esc</span> cancels.
                  </p>
                </>
              ) : game.phase === "combat" ? (
                <>
                  <div className="ab-target">
                    <b className="phase-name" style={{ display: "inline-block" }}>combat</b>
                    {selName ? (
                      <>
                        {" "}
                        from <span className="tn">{selName}</span>
                      </>
                    ) : (
                      " — pick a territory with 2+ armies"
                    )}
                    {tgtName && tgtTerr ? (
                      tgtTerr.owner === youId ? (
                        <>
                          {" "}→ move to <span className="tn">{tgtName}</span>
                        </>
                      ) : (
                        <>
                          {" "}→ attack <span className="tn">{tgtName}</span> ({tgtTerr.armies} def)
                        </>
                      )
                    ) : (
                      " — then an adjacent enemy to attack, or one of your own to move"
                    )}
                  </div>
                  <div className="ab-row">
                    {sel && tgt && selTerr && tgtTerr && tgtTerr.owner !== youId ? (
                      [1, 2, 3].map((d) => (
                        <button
                          key={d}
                          className="btn danger"
                          disabled={selTerr.armies < 2 || Math.min(3, selTerr.armies - 1) < d}
                          onClick={() => send({ t: "attack", from: sel, to: tgt, dice: d })}
                        >
                          Attack {d} {d === 1 ? "die" : "dice"} <span className="kbd">{d}</span>
                        </button>
                      ))
                    ) : sel && tgt && selTerr && tgtTerr && tgtTerr.owner === youId ? (
                      <>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 2}
                          onClick={() => send({ t: "move", from: sel, to: tgt, n: 1 })}
                        >
                          Move 1 <span className="kbd">1</span>
                        </button>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 3}
                          onClick={() => send({ t: "move", from: sel, to: tgt, n: 2 })}
                        >
                          Move 2 <span className="kbd">2</span>
                        </button>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 2}
                          onClick={() => send({ t: "move", from: sel, to: tgt, n: selTerr.armies - 1 })}
                        >
                          Move all ({selTerr.armies - 1})
                        </button>
                      </>
                    ) : (
                      <span className="ab-hint">Select source + target to enable actions.</span>
                    )}
                    <span className="spacer" />
                    <button className="btn primary" onClick={() => send({ t: "pass_combat" })}>
                      Pass combat <span className="kbd">↵</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="ab-target">
                    <b className="phase-name" style={{ display: "inline-block" }}>fortify</b> · {game.fortifyMoves}{" "}
                    {game.fortifyMoves === 1 ? "move" : "moves"} left
                    {selName ? (
                      <>
                        {" "}
                        from <span className="tn">{selName}</span>
                      </>
                    ) : (
                      " — pick a source territory"
                    )}
                    {tgtName ? (
                      <>
                        {" "}
                        → <span className="tn">{tgtName}</span>
                      </>
                    ) : (
                      " — then any territory you control (path through your empire)"
                    )}
                  </div>
                  <div className="ab-row">
                    {sel && tgt && selTerr ? (
                      <>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 2 || game.fortifyMoves < 1}
                          onClick={() => send({ t: "fortify", from: sel, to: tgt, n: 1 })}
                        >
                          Move 1 <span className="kbd">1</span>
                        </button>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 3 || game.fortifyMoves < 1}
                          onClick={() => send({ t: "fortify", from: sel, to: tgt, n: 2 })}
                        >
                          Move 2 <span className="kbd">2</span>
                        </button>
                        <button
                          className="btn"
                          disabled={selTerr.armies < 2 || game.fortifyMoves < 1}
                          onClick={() => send({ t: "fortify", from: sel, to: tgt, n: selTerr.armies - 1 })}
                        >
                          Move all ({selTerr.armies - 1})
                        </button>
                      </>
                    ) : (
                      <span className="ab-hint">Select source + destination to enable moves.</span>
                    )}
                    <span className="spacer" />
                    <button className="btn primary" onClick={() => send({ t: "end_turn" })}>
                      End turn <span className="kbd">↵</span>
                    </button>
                  </div>
                </>
              )
            ) : (
              <p className="ab-hint">
                {owner
                  ? owner.kind === "agent"
                    ? `Waiting — ${owner.name} ${KIND_ICON.agent} is deciding the fate of the world.`
                    : `Waiting — it's ${owner?.name}'s turn.`
                  : "Waiting for the next turn…"}
                {youId ? " The war continues while you watch." : ""}
              </p>
            )}

            {flash && <div className="flash">⚠ {flash}</div>}

            {myTurn && (
              <div className="chat-row">
                <input
                  className="input"
                  value={chatMsg}
                  maxLength={140}
                  placeholder="Broadcast to the war room (max 140)…"
                  onChange={(e) => setChatMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && chatMsg.trim()) {
                      send({ t: "chat", msg: chatMsg.trim() });
                      setChatMsg("");
                    }
                    e.stopPropagation();
                  }}
                />
                <button
                  className="btn"
                  disabled={!chatMsg.trim()}
                  onClick={() => {
                    send({ t: "chat", msg: chatMsg.trim() });
                    setChatMsg("");
                  }}
                >
                  Send
                </button>
              </div>
            )}

            {youId && game.status === "running" && (
              <div className="ab-row" style={{ justifyContent: "flex-end" }}>
                <button
                  className={`btn small ${resignArm ? "danger" : "ghost"}`}
                  onClick={() => {
                    if (resignArm) {
                      send({ t: "resign" });
                      setResignArm(false);
                    } else {
                      setResignArm(true);
                      window.setTimeout(() => setResignArm(false), 4000);
                    }
                  }}
                >
                  {resignArm ? "Click again to surrender" : "Resign"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* right column */}
        <div className="game-side">
          <div className="phase-banner">
            <div className="phase-top">
              <span className="phase-turn">Turn {game.turn}</span>
              <span className="phase-name">
                {game.status === "over" ? "over" : game.phase}
              </span>
            </div>
            {owner ? (
              <div className="phase-who">
                <span className="dot" style={{ background: owner.color }} />
                <b>{owner.name}</b>
                {KIND_ICON[owner.kind]} {owner.kind === "agent" ? "is on the clock" : "is in command"}
              </div>
            ) : (
              <div className="phase-who">—</div>
            )}
            {game.status === "running" && <TurnTimer deadlineMs={game.deadlineMs} totalMs={turnTotal} />}
          </div>

          <div className="player-stack panel">
            <div className="panel-title">
              <span>Players</span>
              <span style={{ fontWeight: 500 }}>{game.players.filter((p) => !p.eliminated).length} alive</span>
            </div>
            {reports.map((r) => (
              <div key={r.id} className={`prow ${!r.alive ? "eliminated" : ""}`}>
                <span className="dot" style={{ background: r.color }} />
                <span className="pname" title={r.name}>
                  {r.name} {KIND_ICON[r.kind]}
                  {r.id === youId && <span className="you-tag"> (you)</span>}
                  {r.botStyle && <span className="muted-note"> · {r.botStyle}</span>}
                </span>
                <span className="pstats">
                  {r.territories}⌂ {r.armies}▲
                </span>
                <span className="pcards">
                  {r.cards.map((c: CardSymbol, i: number) => (
                    <i key={i} className={`card-${c}`}>
                      {c[0].toUpperCase()}
                    </i>
                  ))}
                </span>
                {r.isTurn && r.alive && r.id === youId && <span className="turn-pulse">YOUR TURN</span>}
              </div>
            ))}
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <div className="panel-title" style={{ padding: "10px 12px 0" }}>
              <span>War feed</span>
              <span style={{ fontWeight: 500 }}>{game.feed.length} events</span>
            </div>
            <WarFeed feed={game.feed.slice(-150)} />
          </div>

          <AdSlot size="sidebar" />
        </div>
      </div>

      {/* game over overlay */}
      {game.status === "over" && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="win-crown">🏆</div>
            <h2 style={{ color: game.players.find((p) => p.id === game.winner)?.color ?? "var(--accent)" }}>
              {game.players.find((p) => p.id === game.winner)?.name ?? "Nobody"} takes the world
            </h2>
            <p className="wsub">
              {game.winReason ?? "conquest"} · {game.mode} · {game.turn} turns
            </p>
            <ol className="standings">
              {[...game.players]
                .map((p) => {
                  let terr = 0;
                  let arm = 0;
                  for (const t of Object.values(game.territories)) {
                    if (t.owner === p.id) {
                      terr += 1;
                      arm += t.armies;
                    }
                  }
                  return { p, terr, arm };
                })
                .sort((a, b) => b.terr - a.terr || b.arm - a.arm)
                .map((r, i) => (
                  <li key={r.p.id} className={i === 0 ? "first" : ""}>
                    <span className="rank">{i + 1}</span>
                    <span className="dot" style={{ background: r.p.color }} />
                    <span className="sname">
                      {r.p.name} {KIND_ICON[r.p.kind]}
                    </span>
                    <span className="sstats">
                      {r.terr}⌂ {r.arm}▲
                    </span>
                    {r.p.eliminated && <span className="muted-note">elim.</span>}
                  </li>
                ))}
            </ol>
            <div className="overlay-actions">
              <button className="btn primary" onClick={doShare}>
                {copied ? "Copied ✓" : "Share result"}
              </button>
              <a className="btn" href="#/">
                Back to lobby
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
