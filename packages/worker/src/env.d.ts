/**
 * Global Worker environment (wrangler.toml bindings + secret).
 */
interface Env {
  GAME: DurableObjectNamespace;
  BOARD: DurableObjectNamespace;
  MCP_SECRET: string;
}
