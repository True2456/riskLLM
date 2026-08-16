/**
 * Global Worker environment (wrangler.toml bindings + secrets).
 */
interface Env {
  GAME: DurableObjectNamespace;
  BOARD: DurableObjectNamespace;
  LEAGUE: DurableObjectNamespace;
  MCP_SECRET: string;
  /** OpenRouter key the league uses to field real-LLM seats (free routers + cheap paid). */
  OPENROUTER_KEY?: string;
  /** public site URL, for OpenRouter ranking headers (optional). */
  SITE_URL?: string;
}
