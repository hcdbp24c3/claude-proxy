/**
 * Core types for claude-proxy.
 *
 * A "Provider" is an upstream LLM endpoint speaking either:
 *  - Anthropic Messages API (`type: "anthropic"`), or
 *  - OpenAI Chat Completions API (`type: "openai"`).
 *
 * A "Model alias" is a public name (what Claude Code / Desktop sees) mapped
 * to a `(provider, modelId)` pair. Aliases that *do not* start with `claude`
 * or `anthropic` are still routable: the proxy rewrites the model field to a
 * canonical `claude-<alias>` form on the way out and back, so the downstream
 * Claude clients never see the upstream model id.
 */

/** Upstream API flavour. */
export type ProviderType = "anthropic" | "openai";

/** Static provider configuration loaded from `~/.claude-proxy/config.json`. */
export interface ProviderConfig {
  /** Stable id; e.g. "anthropic-main", "openrouter", "deepseek". */
  id: string;
  /** Human-friendly label for dashboards and logs. */
  label?: string;
  type: ProviderType;
  /** Base URL with no trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /** Bearer / x-api-key value; resolved from env var name if `apiKeyEnv` is set. */
  apiKey?: string;
  /** Read the key from process.env at request time. */
  apiKeyEnv?: string;
  /** Custom headers to forward on every upstream call. */
  headers?: Record<string, string>;
  /** Per-provider request timeout, ms. Default 10 minutes. */
  timeoutMs?: number;
  /** When true, this provider is considered for native passthrough. */
  nativePassthrough?: boolean;
}

/** A model alias exposed to Claude Code / Desktop. */
export interface ModelAlias {
  /** Public name; what the user types. */
  name: string;
  /** Provider id from `ProviderConfig.id`. */
  provider: string;
  /** Upstream model id at that provider. */
  modelId: string;
  /** Optional display label for the dashboard. */
  label?: string;
  /** Optional context window override (tokens). */
  contextWindow?: number;
  /** If true, this model is hidden from /v1/models discovery. */
  hidden?: boolean;
}

/** Top-level configuration object. */
export interface AppConfig {
  /** HTTP listener bind address. Default 127.0.0.1. */
  bind?: string;
  /** HTTP listener port. Default 8765. */
  port?: number;
  /** Optional bearer token clients must send as `Authorization: Bearer ...`. */
  apiKey?: string;
  /** Log level: "silent" | "info" | "debug". */
  logLevel?: "silent" | "info" | "debug";
  /** Providers keyed by id. */
  providers: ProviderConfig[];
  /** Model aliases. */
  models: ModelAlias[];
  /** Default model to use when client omits one. */
  defaultModel?: string;
}

/** Resolved provider (after env-var expansion). */
export interface ResolvedProvider extends ProviderConfig {
  resolvedApiKey: string;
}

/** Effective resolution for a request: which provider + upstream model. */
export interface RouteDecision {
  provider: ResolvedProvider;
  upstreamModel: string;
  /** The public alias name the client asked for (post-rewrite). */
  alias: string;
  /** Native passthrough = forward to upstream without translation. */
  native: boolean;
}
