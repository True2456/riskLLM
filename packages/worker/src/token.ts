// Stateless per-seat bearer tokens: "<gameId>.<playerId>.<hexHMAC>".
// HMAC-SHA256 over "gameId.playerId" keyed by MCP_SECRET.

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeToken(gameId: string, playerId: string, secret: string): Promise<string> {
  return hmac(secret, `${gameId}.${playerId}`).then((h) => `${gameId}.${playerId}.${h}`);
}

export async function verifyToken(token: string, secret: string): Promise<{ gameId: string; playerId: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [gameId, playerId, given] = parts;
  if (!/^[a-z0-9]{6,16}$/.test(gameId) || !/^[a-z0-9]{1,16}$/.test(playerId)) return null;
  const want = await hmac(secret, `${gameId}.${playerId}`);
  if (want.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? { gameId, playerId } : null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}
