// The centerpiece: SVG world map (1000x420).
// Land outline (Natural Earth 110m) + 42 territory nodes + route lines.
// Memoized on state identity/version — the map only re-renders on state change.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ADJACENCY,
  TERRITORIES,
  TERRITORY_BY_ID,
  ownedPath,
  type GameState,
  type PlayerState,
} from "@riskllm/engine";
import { project, VIEW_W } from "../lib/projection";
import { LAND_PATH } from "../lib/world";

export interface FxView {
  seq: number;
  from: string;
  to: string;
  attLost: number;
  defLost: number;
  conquered: boolean;
}

interface Props {
  state: GameState;
  version: number;
  youId: string | null;
  sel: string | null;
  tgt: string | null;
  fx: FxView | null;
  onPick(id: string): void;
}

const NEUTRAL = "#39445c";

/* ------------------------------------------------------------------ routes */

interface RouteSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  seas: boolean;
}

const WRAP_PAIRS: [string, string][] = [
  ["ALA", "KAM"], // sea route across the Pacific
];

function isWrap(a: string, b: string): boolean {
  return WRAP_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** All 83 routes, deduped, with the ALA-KAM Pacific wrap split into 2 edge segments. */
const ROUTES: RouteSeg[] = (() => {
  const seen = new Set<string>();
  const segs: RouteSeg[] = [];
  for (const t of TERRITORIES) {
    for (const nb of ADJACENCY[t.id]) {
      const key = [t.id, nb].sort().join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const a = TERRITORY_BY_ID[t.id];
      const b = TERRITORY_BY_ID[nb];
      if (isWrap(t.id, nb)) {
        const [ax, ay] = project(a.lon, a.lat);
        const [bx, by] = project(b.lon, b.lat);
        // one segment off the left edge, one coming in on the right edge
        segs.push({ x1: ax, y1: ay, x2: 0, y2: ay, seas: true });
        segs.push({ x1: VIEW_W, y1: by, x2: bx, y2: by, seas: true });
        continue;
      }
      const [x1, y1] = project(a.lon, a.lat);
      const [x2, y2] = project(b.lon, b.lat);
      const seas = t.id === "BRA" && nb === "NAF";
      segs.push({ x1, y1, x2, y2, seas });
    }
  }
  return segs;
})();

/* ------------------------------------------------------------ graticule */

const GRATICULE: { x1: number; y1: number; x2: number; y2: number }[] = (() => {
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let lon = -150; lon <= 150; lon += 30) {
    const [x1] = project(lon, 78);
    const [x2] = project(lon, -58);
    out.push({ x1, y1: 0, x2, y2: 420 });
  }
  for (let lat = 60; lat >= -30; lat -= 30) {
    const [, y1] = project(-175, lat);
    const [, y2] = project(180, lat);
    out.push({ x1: 0, y1, x2: VIEW_W, y2 });
  }
  return out;
})();

/* ------------------------------------------------------------------ node */

const NODE_POS: Record<string, [number, number]> = Object.fromEntries(
  TERRITORIES.map((t) => [t.id, project(t.lon, t.lat)]),
);

function nodeRadius(armies: number): number {
  // bigger base + wider range so the board reads as glowing orbs, sized by strength
  return 8 + Math.min(13, Math.sqrt(Math.max(0, armies)) * 1.9);
}

/* ------------------------------------------------------------------ comp */

function MapCanvasInner({ state, version, youId, sel, tgt, fx, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [battle, setBattle] = useState<FxView | null>(null);
  const lastFxSeen = useRef(0);

  const playersById = useMemo(() => {
    const m = new Map<string, PlayerState>();
    for (const p of state.players) m.set(p.id, p);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, version]);

  // Battle flash: animate when a NEW fx seq arrives (keyed by feed seq).
  useEffect(() => {
    if (!fx) return;
    if (fx.seq <= lastFxSeen.current) return;
    lastFxSeen.current = fx.seq;
    setBattle(fx);
    const t = window.setTimeout(() => setBattle(null), 1100);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fx ? fx.seq : 0]);

  // Selection semantics for ring rendering.
  const mySet = useMemo(() => {
    if (!youId) return null;
    const s = new Set<string>();
    for (const [id, t] of Object.entries(state.territories)) if (t.owner === youId) s.add(id);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, version, youId]);

  const selTerr = sel ? state.territories[sel] : null;
  const selIsMine = selTerr !== null && youId !== null && selTerr.owner === youId;
  const deployable = state.phase === "reinforce" && mySet;
  const attackable = new Set<string>();
  const movable = new Set<string>();
  if (selIsMine && selTerr && sel) {
    for (const nb of ADJACENCY[sel]) {
      const t = state.territories[nb];
      if (state.phase === "combat") {
        if (t.owner === youId) movable.add(nb);
        else if (t.owner !== null && selTerr.armies >= 2) attackable.add(nb);
      } else if (state.phase === "fortify" && mySet) {
        if (t.owner === youId && ownedPath(sel, nb, youId, mySet)) movable.add(nb);
      }
    }
  }

  const hoverTerr = hover ? state.territories[hover] : null;
  const hoverOwner = hoverTerr?.owner ? playersById.get(hoverTerr.owner) : null;

  const moveTip = (e: React.MouseEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setTipPos({ x: Math.min(x + 14, r.width - 150), y: Math.min(y + 14, r.height - 90) });
  };

  return (
    <div className="map-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${VIEW_W} 420`}
        className="map-svg"
        role="img"
        aria-label="World map with 42 territories"
      >
        <g className="graticule" aria-hidden="true">
          {GRATICULE.map((g, i) => (
            <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
          ))}
        </g>
        <path className="land" d={LAND_PATH} aria-hidden="true" />
        <g className="routes" aria-hidden="true">
          {ROUTES.map((r, i) => (
            <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} className={r.seas ? "seas" : undefined} />
          ))}
        </g>

        {battle && (
          <g pointerEvents="none" aria-hidden="true">
            {isWrap(battle.from, battle.to) ? (
              <>
                {(() => {
                  const [ax, ay] = NODE_POS[battle.from];
                  const [bx, by] = NODE_POS[battle.to];
                  return (
                    <>
                      <line className="battle-line" x1={ax} y1={ay} x2={0} y2={ay} />
                      <line className="battle-line" x1={VIEW_W} y1={by} x2={bx} y2={by} />
                    </>
                  );
                })()}
              </>
            ) : (
              (() => {
                const [x1, y1] = NODE_POS[battle.from];
                const [x2, y2] = NODE_POS[battle.to];
                return (
                  <>
                    <line className="battle-line" x1={x1} y1={y1} x2={x2} y2={y2} />
                    {battle.conquered && <circle className="conq-flash" cx={x2} cy={y2} r={10} />}
                  </>
                );
              })()
            )}
            {(() => {
              const [x1, y1] = NODE_POS[battle.from];
              const [x2, y2] = NODE_POS[battle.to];
              return (
                <text className="battle-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} textAnchor="middle">
                  {battle.conquered ? `×${battle.defLost} ⚑` : `×${battle.defLost}`}
                </text>
              );
            })()}
          </g>
        )}

        <g>
          {TERRITORIES.map((t) => {
            const [x, y] = NODE_POS[t.id];
            const ts = state.territories[t.id];
            const owner = ts.owner ? playersById.get(ts.owner) : null;
            const r = nodeRadius(ts.armies);
            const fill = owner ? (ts.armies > 0 ? owner.color : NEUTRAL) : NEUTRAL;
            const dimmed = owner !== null && ts.armies === 0;
            const isSel = sel === t.id;
            const isTgt = tgt === t.id;
            const atk = attackable.has(t.id);
            const mov = movable.has(t.id);
            const dep = deployable ? deployable.has(t.id) : false;
            const showName = isSel || isTgt || hover === t.id || atk || mov;
            const glow = owner && ts.armies > 0 ? `drop-shadow(0 0 ${Math.max(3, r * 0.55).toFixed(1)}px ${fill})` : undefined;
            return (
              <g
                key={t.id}
                className="territory"
                tabIndex={0}
                role="button"
                aria-label={`${t.name} — ${owner ? owner.name : "unclaimed"}, ${ts.armies} armies`}
                onClick={() => onPick(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(t.id);
                  }
                }}
                onMouseEnter={() => setHover(t.id)}
                onMouseMove={moveTip}
                onMouseLeave={() => setHover(null)}
              >
                {dep && <circle className="deploy-ring" cx={x} cy={y} r={r + 3} />}
                {mov && <circle className="move-ring" cx={x} cy={y} r={r + 4} />}
                {atk && <circle className="attack-ring" cx={x} cy={y} r={r + 4} />}
                {isSel && <circle className="sel-ring" cx={x} cy={y} r={r + 5} />}
                {isTgt && <circle className="tgt-ring" cx={x} cy={y} r={r + 7} />}
                <circle className="node" cx={x} cy={y} r={r} fill={fill} opacity={dimmed ? 0.35 : 1} style={{ filter: glow }} />
                {showName && (
                  <text className="terr-label" x={x} y={y - r - 6} textAnchor="middle">
                    {t.name}
                  </text>
                )}
                {ts.armies > 0 && (
                  <text className="terr-count" x={x} y={y + 3.6} textAnchor="middle">
                    {ts.armies}
                  </text>
                )}
                {dep && isSel && (
                  <text className="deploy-badge" x={x} y={y + r + 15} textAnchor="middle">
                    +{state.toReinforce}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hover && hoverTerr && (
        <div className="map-tip" style={{ left: tipPos.x, top: tipPos.y }}>
          <div className="tip-name">
            {TERRITORY_BY_ID[hover].name}
            <span className="muted-note" style={{ margin: 0, marginLeft: 8 }}>
              {TERRITORY_BY_ID[hover].continent}
            </span>
          </div>
          <div className="tip-row">
            <span className="dot" style={{ background: hoverOwner ? hoverOwner.color : NEUTRAL }} />
            {hoverOwner ? hoverOwner.name : "no owner"} · {hoverTerr.armies}{" "}
            {hoverTerr.armies === 1 ? "army" : "armies"}
          </div>
          <div className="tip-adj">
            adj: {ADJACENCY[hover].map((id) => TERRITORY_BY_ID[id].name).join(", ")}
          </div>
        </div>
      )}
    </div>
  );
}

export const MapCanvas = memo(
  MapCanvasInner,
  (a, b) =>
    a.state === b.state &&
    a.version === b.version &&
    a.youId === b.youId &&
    a.sel === b.sel &&
    a.tgt === b.tgt &&
    a.fx === b.fx &&
    a.onPick === b.onPick,
);
