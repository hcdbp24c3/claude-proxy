/**
 * Routing: resolve a public model name (what Claude Code / Desktop sent) to
 * an upstream `(provider, modelId)` pair.
 *
 * The whole point of this proxy is to defeat Claude's model-name guard
 * `^(claude|anthropic)` that the upstream endpoint applies. We do that by
 * letting users register aliases under *any* name (gpt-5, deepseek-chat,
 * gemini-pro, etc.) and rewriting the model field on the way to a non-Anthropic
 * upstream.
 *
 * The model field travels:
 *   1. Client -> proxy: whatever the user typed, e.g. "gpt-5".
 *   2. Proxy routing: look up alias, decide provider + upstream modelId.
 *   3. Proxy -> upstream:
 *        - Anthropic native passthrough: model = original (or alias).
 *        - OpenAI-compat: model = upstream modelId (e.g. "gpt-5-2025-01-01").
 *   4. Upstream response: streamed back unchanged except for
 *      translate-OpenAI->Anthropic on the way out.
 */
import type { AppConfig, ModelAlias, ProviderConfig, ResolvedProvider, RouteDecision } from "./types.ts";
import { resolveApiKey } from "./config/config.ts";

/** Built-in aliases injected if the user hasn't supplied their own. */
const BUILTIN_FALLBACK_ALIASES: ModelAlias[] = [
  {
    name: "claude-3-5-sonnet-latest",
    label: "Claude 3.5 Sonnet (passthrough)",
    provider: "__passthrough__",
    modelId: "claude-3-5-sonnet-latest",
  },
  {
    name: "claude-3-5-haiku-latest",
    label: "Claude 3.5 Haiku (passthrough)",
    provider: "__passthrough__",
    modelId: "claude-3-5-haiku-latest",
  },
];

/** Sentinel id used by built-in passthrough aliases. */
const PASSTHROUGH_ID = "__passthrough__";

/** Build the runtime provider list, with API keys resolved. */
export function resolveProviders(config: AppConfig): ResolvedProvider[] {
  return config.providers.map((p) => ({ ...p, resolvedApiKey: resolveApiKey(p) }));
}

/** Build the effective model alias list, with built-in passthroughs appended. */
export function resolveModels(config: AppConfig): ModelAlias[] {
  const user = config.models ?? [];
  const userNames = new Set(user.map((m) => m.name));
  return [...user, ...BUILTIN_FALLBACK_ALIASES.filter((b) => !userNames.has(b.name))];
}

/** Decide the route for a request. Throws on miss. */
export function decideRoute(config: AppConfig, requestedModel: string): RouteDecision {
  const providers = resolveProviders(config);
  const models = resolveModels(config);

  const requested = requestedModel?.trim() || config.defaultModel || "";
  if (!requested) {
    throw new RoutingError(
      400,
      "invalid_request_error",
      "No model specified and no defaultModel configured",
    );
  }

  if (requested === PASSTHROUGH_ID) {
    throw new RoutingError(500, "api_error", "passthrough placeholder reached decideRoute");
  }

  const alias = models.find((m) => m.name === requested);
  if (!alias) {
    // Gateway-discovered models get a "claude-" prefix injected so Claude
    // Code's filter lets them through. Strip the prefix to find the
    // underlying alias.
    const stripped = requested.replace(/^claude-/i, "");
    const alt = stripped !== requested ? models.find((m) => m.name === stripped) : undefined;
    if (alt) {
      return { provider: resolveProviders(config).find((p) => p.id === alt.provider)!, upstreamModel: alt.modelId, alias: alt.name, native: false };
    }
    // Last-ditch: any model name starting with claude/anthropic is treated
    // as a passthrough so users can use Anthropic models they have creds for
    // without registering them.
    if (/^(claude|anthropic)/i.test(requested)) {
      return {
        provider: synthesisePassthroughProvider(config),
        upstreamModel: requested,
        alias: requested,
        native: true,
      };
    }
    throw new RoutingError(
      404,
      "not_found_error",
      `Unknown model '${requested}'. Add an alias with: claude-proxy model add --name ${requested} --provider <id> --model-id <upstream-id>`,
    );
  }

  if (alias.provider === PASSTHROUGH_ID) {
    return {
      provider: synthesisePassthroughProvider(config),
      upstreamModel: alias.modelId,
      alias: alias.name,
      native: true,
    };
  }

  const provider = providers.find((p) => p.id === alias.provider);
  if (!provider) {
    throw new RoutingError(
      500,
      "configuration_error",
      `Alias '${alias.name}' references missing provider '${alias.provider}'`,
    );
  }

  // Anthropic providers receive the alias's upstream id directly.
  if (provider.type === "anthropic") {
    return { provider, upstreamModel: alias.modelId, alias: alias.name, native: true };
  }

  return { provider, upstreamModel: alias.modelId, alias: alias.name, native: false };
}

/** A passthrough "provider" that just forwards to the configured Anthropic
 *  endpoint with the user's auth. */
function synthesisePassthroughProvider(config: AppConfig): ResolvedProvider {
  const envBase = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const envKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  const explicit = config.providers.find((p) => p.nativePassthrough && p.type === "anthropic");
  const base: ProviderConfig = explicit ?? {
    id: PASSTHROUGH_ID,
    label: "Anthropic (passthrough)",
    type: "anthropic",
    baseUrl: envBase,
    apiKey: envKey,
    nativePassthrough: true,
  };
  return {
    ...base,
    resolvedApiKey: base.apiKeyEnv ? resolveApiKey(base) : (base.apiKey ?? envKey),
  };
}

export class RoutingError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
    this.name = "RoutingError";
  }
  toAnthropicBody() {
    return { type: "error", error: { type: this.type, message: this.message } };
  }
}
