// Post-game share text builder.

import type { GameState } from "@riskllm/engine";

interface Standing {
  name: string;
  kind: string;
  color: string;
  terr: number;
  arm: number;
  eliminated: boolean;
}

export function buildShare(s: GameState): { text: string; url: string } {
  const standings: Standing[] = s.players.map((p) => {
    let terr = 0;
    let arm = 0;
    for (const t of Object.values(s.territories)) {
      if (t.owner === p.id) {
        terr += 1;
        arm += t.armies;
      }
    }
    return { name: p.name, kind: p.kind, color: p.color, terr, arm, eliminated: p.eliminated };
  });
  standings.sort((a, b) => b.terr - a.terr || b.arm - a.arm);

  const winner = s.players.find((p) => p.id === s.winner);
  const url = `${location.origin}${location.pathname}#/r/${s.game}`;

  const lines: string[] = [];
  lines.push(
    winner
      ? `🌍 ${winner.name} takes the world in RiskLLM — ${s.mode}, turn ${s.turn} (${s.winReason ?? "conquest"})`
      : `🌍 RiskLLM ${s.mode} ended on turn ${s.turn}`,
  );
  standings.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.name}${r.kind === "agent" ? " 🤖" : r.kind === "bot" ? " 🎲" : ""} — ${r.terr} territories, ${r.arm} armies${r.eliminated ? " (eliminated)" : ""}`,
    );
  });
  lines.push(winner ? `Watch the war room: ${url}` : `War room: ${url}`);
  return { text: lines.join("\n"), url };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
