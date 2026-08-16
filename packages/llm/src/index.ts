/**
 * LLM provider pool for RiskLLM battles.
 *
 * Unifies the ways we can field a "real LLM" at a seat, all through OpenAI-
 * compatible endpoints (one OpenRouter key covers the free + cheap options):
 *
 *   auto   openrouter/auto              FREE  smart meta-router (best cheap model per task)
 *   free   openrouter/free              FREE  random free model, filters for tool calling
 *   ling   inclusionai/ling-2.6-flash   paid  ~$0.01/$0.03 per M tokens — the reliable backstop
 *
 * The pool is 429-aware: when a free router hits its daily/hourly limit it is
 * put on cooldown and the call falls through to the next provider (free first,
 * paid last), so a battle never stalls because one free tier ran dry. That is
 * what lets us keep a game running 24/7 for ~$0.
 *
 * Pure TS, uses global fetch (Node 18+ and Cloudflare Workers both provide it).
 */

// ------------------------------------------------------------------- types

export interface LlmMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface Provider {
  id: string;
  label: string;
  /** OpenRouter model slug */
  model: string;
  tier: "free" | "paid";
  notes?: string;
}

export type Strategy = "auto" | "free" | "ling" | "rotate";

export interface LlmResult {
  message: LlmMsg;
  /** the provider we actually called */
  provider: Provider;
  /** the concrete model the router chose (OpenRouter echoes this back) */
  routedModel?: string;
}

// --------------------------------------------------------------- providers

export const PROVIDERS: Provider[] = [
  { id: "auto", label: "Auto", model: "openrouter/auto", tier: "free", notes: "free smart router" },
  { id: "free", label: "Free", model: "openrouter/free", tier: "free", notes: "free rotating, tool-calling aware" },
  { id: "ling", label: "Ling 2.6 Flash", model: "inclusionai/ling-2.6-flash", tier: "paid", notes: "$0.01/$0.03 per M tokens" },
];

const byId = (id: string): Provider => {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
};

// ------------------------------------------------------------------- pool

export interface PoolOptions {
  key: string;
  baseUrl?: string;
  /** referer/title headers for OpenRouter rankings (optional) */
  referer?: string;
  title?: string;
  /** how long a 429'd provider is cooled down (ms) */
  cooldownMs?: number;
  /** temperature / max tokens for the battle */
  temperature?: number;
  maxTokens?: number;
}

/**
 * A rotating, 429-aware set of LLM providers. `call()` tries providers in a
 * strategy-defined order (free first, paid backstop) and returns the first
 * success, so a single call never fails just because one free tier is dry.
 */
export class Pool {
  private cooldowns = new Map<string, number>(); // id -> ms timestamp until retryable
  private disabled = new Set<string>(); // id -> persistently unavailable (e.g. 403 no credit)
  private nextCallAt = 0; // global free-tier pacing: don't call before this
  private cursor = 0;

  constructor(private o: PoolOptions) {
    if (!o.key) throw new Error("Pool requires an API key");
  }

  get key(): string {
    return this.o.key;
  }

  /** ordered list of providers to try for a strategy (before cooldowns) */
  orderFor(strategy: Strategy): Provider[] {
    switch (strategy) {
      case "ling":
        return [byId("ling")];
      case "free":
        return [byId("free"), byId("auto"), byId("ling")];
      case "rotate": {
        // round-robin across all, free first, so consecutive games use different models
        const free = PROVIDERS.filter((p) => p.tier === "free");
        const paid = PROVIDERS.filter((p) => p.tier === "paid");
        const all = [...free, ...paid];
        const start = this.cursor % all.length;
        this.cursor++;
        return [...all.slice(start), ...all.slice(0, start)];
      }
      case "auto":
      default:
        return [byId("auto"), byId("free"), byId("ling")];
    }
  }

  inCooldown(id: string, now = Date.now()): boolean {
    return this.disabled.has(id) || (this.cooldowns.get(id) ?? 0) > now;
  }

  cooldownRemainingMs(id: string, now = Date.now()): number {
    if (this.disabled.has(id)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (this.cooldowns.get(id) ?? 0) - now);
  }

  /** 429 (rate limit) — temporary: cool down briefly + pace the whole pool. */
  note429(p: Provider, ms?: number): void {
    const wait = ms ?? this.o.cooldownMs ?? 20_000;
    this.cooldowns.set(p.id, Date.now() + wait);
    // pace globally so we don't immediately hammer the next free model
    this.nextCallAt = Math.max(this.nextCallAt, Date.now() + Math.min(wait, 15_000));
  }

  /** 403 (no credit / permission) — persistent for this session: stop trying it. */
  noteDisabled(p: Provider): void {
    this.disabled.add(p.id);
  }

  /** snapshot for the lobby / debugging: who is available right now */
  status(): { id: string; label: string; tier: "free" | "paid"; available: boolean; cooldownS: number }[] {
    return PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      tier: p.tier,
      available: !this.inCooldown(p.id),
      cooldownS: this.disabled.has(p.id) ? -1 : Math.round(this.cooldownRemainingMs(p.id) / 1000),
    }));
  }

  /**
   * Call the LLM with tools, rotating across providers (free -> paid backstop).
   * 429 (rate limit) is treated as temporary: that provider is cooled down and
   * the pool paces + retries until a free window opens (up to `maxWaitMs`).
   * 403 (no credit) is treated as persistent: that provider is disabled for the
   * session. Only throws when every provider is persistently unavailable or the
   * wait budget is exhausted — so a transient free-tier rate-limit window does
   * NOT kill a battle.
   */
  async call(
    tools: unknown[],
    messages: LlmMsg[],
    strategy: Strategy = "auto",
    maxWaitMs = 180_000,
  ): Promise<LlmResult> {
    const order = this.orderFor(strategy);
    const deadline = Date.now() + maxWaitMs;
    let lastErr: unknown = null;

    for (;;) {
      // global free-tier pacing: wait out the last 429 before hammering again
      const waitTo = this.nextCallAt - Date.now();
      if (waitTo > 0) await new Promise((r) => setTimeout(r, waitTo));

      for (const p of order) {
        if (this.inCooldown(p.id)) continue;
        try {
          const res = await fetch(`${this.o.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.o.key}`,
              ...(this.o.referer ? { "HTTP-Referer": this.o.referer } : {}),
              ...(this.o.title ? { "X-Title": this.o.title } : {}),
            },
            body: JSON.stringify({
              model: p.model,
              messages,
              tools,
              tool_choice: "auto",
              temperature: this.o.temperature ?? 0.8,
              max_tokens: this.o.maxTokens ?? 1500,
            }),
          });
          if (res.status === 429) {
            const ra = Number(res.headers.get("retry-after") ?? 0) * 1000; // honor Retry-After if present
            this.note429(p, Number.isFinite(ra) && ra > 0 ? ra : undefined);
            lastErr = new Error(`${p.id}: 429 rate limited`);
            continue; // try the next provider now
          }
          if (res.status === 403) {
            this.noteDisabled(p); // no credit / permission — won't fix itself
            lastErr = new Error(`${p.id}: 403 (disabled)`);
            continue;
          }
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok) {
            this.note429(p, 15_000); // transient: cool down, try next
            lastErr = new Error(`${p.id}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 160)}`);
            continue;
          }
          const m = data?.choices?.[0]?.message;
          if (!m) throw new Error(`${p.id}: empty response`);
          return {
            provider: p,
            routedModel: data.model,
            message: {
              role: "assistant",
              content: m.content ?? null,
              tool_calls: m.tool_calls?.map((tc: any) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            },
          };
        } catch (e) {
          lastErr = e;
          this.note429(p, 15_000);
        }
      }

      // every provider was in cooldown: check if it's a dead end or a wait-and-retry
      const anyDisabledOnly = order.every((p) => this.disabled.has(p.id));
      if (anyDisabledOnly) break; // all persistently unavailable
      if (Date.now() >= deadline) break; // wait budget exhausted
      // some are just rate-limited: wait a beat and retry
      await new Promise((r) => setTimeout(r, 8000));
    }

    throw new Error(`all LLM providers unavailable (${strategy}): ${String(lastErr)}`);
  }
}
