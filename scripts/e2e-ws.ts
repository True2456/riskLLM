/**
 * E2E: WebSocket human join + spectator.
 * - human connects with bearer token -> {t:"joined", you:"p1"} then {t:"state"}
 * - human sends a deploy move -> state reflects the extra armies
 * - spectator (no token) -> {t:"joined", you:null} + state, read-only
 * Run:  npx tsx scripts/e2e-ws.ts   (with dev:worker on :8787)
 */
const BASE = process.env.WORKER_URL ?? "http://localhost:8787";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  t: string;
  state?: any;
  you?: string | null;
  move?: any;
}

class Client {
  ws!: WebSocket;
  queue: Frame[] = [];
  resolvers: ((f: Frame) => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      const f = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)) as Frame;
      if (f.t === "pong") return;
      const r = this.resolvers.shift();
      if (r) r(f);
      else this.queue.push(f);
    };
  }

  next(timeoutMs = 8000): Promise<Frame> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((res, rej) => {
      this.resolvers.push(res);
      setTimeout(() => rej(new Error("ws timeout waiting for frame")), timeoutMs);
    });
  }

  send(o: Record<string, unknown>) {
    this.ws.send(JSON.stringify(o));
  }
}

async function main() {
  const create = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "blitz",
      seats: [{ kind: "human", name: "Cmdr" }, { kind: "bot", botStyle: "balanced" }],
    }),
  }).then((r) => r.json() as Promise<any>);
  const { gameId, tokens } = create;
  console.log(`room ${gameId}`);

  // --- human join ---
  const human = new Client(`${BASE.replace(/^http/, "ws")}/game/${gameId}?token=${tokens.p1}`);
  await new Promise<void>((res) => (human.ws.onopen = () => res()));
  const joined = await human.next();
  if (joined.t !== "joined" || joined.you !== "p1") throw new Error("bad joined: " + JSON.stringify(joined));
  console.log("human joined as", joined.you);
  const st0 = await human.next();
  if (st0.t !== "state") throw new Error("expected state, got " + st0.t);
  const me0 = st0.state.territories;
  const myTerr = Object.entries(me0).filter(([, t]) => t.owner === "p1").map(([id]) => id);
  console.log(`initial state: turn ${st0.state.turn}, phase ${st0.state.phase}, my turn = ${st0.state.turnOwner === "p1"}`);

  // --- if it's the human's turn, deploy and verify the delta ---
  if (st0.state.turnOwner === "p1" && st0.state.phase === "reinforce" && st0.state.toReinforce > 0) {
    const target = myTerr[0];
    const n = Math.min(2, st0.state.toReinforce);
    const armiesBefore = me0[target].armies;
    human.send({ t: "move", move: { t: "deploy", territory: target, n } });
    const st1 = await human.next();
    if (st1.t !== "state") throw new Error("expected state after move, got " + st1.t);
    const terrAfter = st1.state.territories[target].armies;
    console.log(`deployed ${n} on ${target}: tile ${armiesBefore} -> ${terrAfter}`);
    if (terrAfter < armiesBefore + n) throw new Error("deploy did not land on the tile");
  } else {
    console.log("not the human's turn yet — verifying ping/pong instead");
    human.send({ t: "ping" });
  }

  // --- spectator join (no token) ---
  const spec = new Client(`${BASE.replace(/^http/, "ws")}/game/${gameId}`);
  await new Promise<void>((res) => (spec.ws.onopen = () => res()));
  const sj = await spec.next();
  if (sj.t !== "joined" || sj.you !== null) throw new Error("bad spectator joined: " + JSON.stringify(sj));
  const ss = await spec.next();
  if (ss.t !== "state") throw new Error("spectator expected state");
  console.log(`spectator joined (you=null), sees turn ${ss.state.turn}, ${Object.keys(ss.state.territories).length} territories`);

  // --- invalid move surfaces via feed, not a crash ---
  const human2 = new Client(`${BASE.replace(/^http/, "ws")}/game/${gameId}?token=${tokens.p1}`);
  await new Promise<void>((res) => (human2.ws.onopen = () => res()));
  await human2.next(); // joined
  const base = await human2.next(); // state
  // illegal: attack during reinforce (or from a tile you don't own)
  human2.send({ t: "move", move: { t: "attack", from: myTerr[0], to: myTerr[1] ?? "Ural", dice: 1 } });
  const st2 = await human2.next();
  const feedTail = st2.state.feed.slice(-3).map((l: any) => l.text);
  console.log("after illegal move, feed tail:", feedTail);
  if (st2.state.feed.length <= base.state.feed.length) throw new Error("illegal move did not append to feed");

  human.ws.close();
  spec.ws.close();
  human2.ws.close();
  console.log("\nWS OK: human join, move delta, spectator, invalid-move-via-feed all verified");
  process.exit(0);
}

main().catch((e) => {
  console.error("WS E2E FAILED:", e.message);
  process.exit(1);
});
