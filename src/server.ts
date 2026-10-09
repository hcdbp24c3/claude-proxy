/**
 * The proxy itself: a Bun.serve() HTTP listener that accepts Anthropic-format
 * requests at /v1/messages and routes them.
 *
 * Routes:
 *   POST /v1/messages                -> routed or passthrough
 *   POST /v1/messages/count_tokens   -> 200 stub with token estimate
 *   GET  /v1/models                  -> discovery of all configured aliases
 *   GET  /healthz                    -> 200 OK
 *   GET  /                           -> static dashboard
 *
 * Authentication: optional bearer. If `config.apiKey` is set, the caller must
 * present `Authorization: Bearer <key>` or `x-api-key: <key>`. We strip these
 * from upstream traffic; the per-provider key is injected instead.
 */
import { decideRoute, RoutingError } from "./router.ts";
import { anthropicToOpenAI, type AnthropicMessagesBody } from "./translate/anthropic-to-openai.ts";
import {
  newSseState,
  openAIToAnthropicMessage,
  openAIDeltaToAnthropicSse,
  parseOpenAISseLine,
  sseFrame,
  type OpenAIChatResponse,
} from "./translate/openai-to-anthropic.ts";
import { loadConfig } from "./config/config.ts";
import { type AppConfig, type ModelAlias, type ProviderConfig, type ResolvedProvider } from "./types.ts";
import { resolveProviders } from "./router.ts";
import { discoverModelsForProvider, fetchModelList } from "./discovery/models.ts";

/** Headers that should never be forwarded to an upstream. */
const STRIPPED_REQUEST_HEADERS: Record<string, true> = {
  host: true,
  "content-length": true,
  connection: true,
  authorization: true,
  "x-api-key": true,
};

/** Headers to keep on the response (after stripping hop-by-hop). */
const STRIPPED_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  "transfer-encoding": true,
  "content-encoding": true,
};

export interface ProxyServer {
  port: number;
  hostname: string;
  stop: () => void;
}

export async function startProxyServer(
  config: AppConfig,
  options: { hostname?: string; port?: number } = {},
): Promise<ProxyServer> {
  const hostname = options.hostname ?? config.bind ?? "127.0.0.1";
  const port = options.port ?? config.port ?? 8765;
  const apiKey = config.apiKey;
  if (typeof port !== "number") throw new Error("port must be a number");
  if (typeof hostname !== "string") throw new Error("hostname must be a string");

  const server = Bun.serve({
    hostname,
    port,
    // SSE streams can take minutes for long generations. Default idleTimeout
    // is 10s; bump to the max (255s ≈ 4.25 min) so we don't cut off a
    // slow upstream mid-stream.
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // Auth gate
      if (apiKey && !checkAuth(req, apiKey)) {
        return anthropicError(401, "authentication_error", "Invalid or missing API key");
      }

      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });

      if (url.pathname === "/v1/models" || url.pathname === "/v1/models/claude") {
        return handleModels(req, config);
      }

      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
        return handleCountTokens(req);
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        return handleMessages(req, config);
      }

      if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/index.html") {
        return serveDashboard();
      }

      if (url.pathname.startsWith("/admin/")) {
        return handleAdmin(req, config, url.pathname);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  log(config, `claude-proxy listening on http://${hostname}:${server.port!}`);
  return {
    port: server.port!,
    hostname: server.hostname ?? "127.0.0.1",
    stop: () => server.stop(true),
  };
}

function checkAuth(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m && m[1] === expected) return true;
  }
  const xKey = req.headers.get("x-api-key");
  if (xKey === expected) return true;
  return false;
}

/* ------------------------------ /v1/messages -------------------------------- */

async function handleMessages(req: Request, config: AppConfig): Promise<Response> {
  let body: AnthropicMessagesBody;
  try {
    body = (await req.json()) as AnthropicMessagesBody;
  } catch (e) {
    return anthropicError(400, "invalid_request_error", `Invalid JSON body: ${(e as Error).message}`);
  }

  if (typeof body.model !== "string" || !body.model) {
    return anthropicError(400, "invalid_request_error", "Missing required field: model");
  }

  let decision;
  try {
    decision = decideRoute(config, body.model);
  } catch (e) {
    if (e instanceof RoutingError) {
      return anthropicError(e.status, e.type, e.message);
    }
    return anthropicError(500, "api_error", `Routing failed: ${(e as Error).message}`);
  }

  // Always rewrite the model field to the upstream id so the *upstream* sees
  // its own identifier, not the public alias.
  body.model = decision.upstreamModel;

  if (decision.provider.type === "anthropic" || decision.native) {
    return handleAnthropicPassthrough(req, decision.provider, body);
  }
  return handleOpenAITranslation(req, decision.provider, body, decision.alias);
}

async function handleAnthropicPassthrough(
  req: Request,
  provider: ResolvedProvider,
  body: AnthropicMessagesBody,
): Promise<Response> {
  const url = joinUrl(provider.baseUrl, "v1/messages");
  const headers = buildUpstreamHeaders(req, provider);
  headers.set("content-type", "application/json");
  if (provider.resolvedApiKey) {
    headers.set("x-api-key", provider.resolvedApiKey);
  }
  // Required Anthropic version header
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }

  const upstream = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, provider.timeoutMs ?? 600_000);

  return copyResponse(upstream);
}

async function handleOpenAITranslation(
  req: Request,
  provider: ResolvedProvider,
  body: AnthropicMessagesBody,
  alias: string,
): Promise<Response> {
  const translated = anthropicToOpenAI(body, body.model);
  const url = joinUrl(provider.baseUrl, "chat/completions");
  const headers = buildUpstreamHeaders(req, provider);
  headers.set("content-type", "application/json");
  if (provider.resolvedApiKey) {
    headers.set("authorization", `Bearer ${provider.resolvedApiKey}`);
  }

  if (body.stream === true) {
    return streamOpenAIToAnthropic(url, headers, translated, alias);
  }
  return nonStreamOpenAIToAnthropic(url, headers, translated, alias);
}

async function nonStreamOpenAIToAnthropic(
  url: string,
  headers: Headers,
  body: unknown,
  alias: string,
): Promise<Response> {
  const upstream = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    return translateOpenAIError(upstream, text);
  }
  let parsed: OpenAIChatResponse;
  try {
    parsed = JSON.parse(text) as OpenAIChatResponse;
  } catch (e) {
    return anthropicError(502, "api_error", `Upstream returned non-JSON: ${(e as Error).message}`);
  }
  const anthropicBody = openAIToAnthropicMessage(parsed, alias);
  return new Response(JSON.stringify(anthropicBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function streamOpenAIToAnthropic(
  url: string,
  headers: Headers,
  body: unknown,
  alias: string,
): Promise<Response> {
  const upstream = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return translateOpenAIError(upstream, text);
  }

  const state = newSseState();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (state.started && !state.stopped) {
            // Upstream closed without finish_reason; flush message_stop.
            controller.enqueue(encoder.encode(sseFrame("message_stop", { type: "message_stop" })));
          }
          controller.close();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        // SSE line parser: split on \n, keep \n as separator.
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const parsed = parseOpenAISseLine(line);
            if (!parsed) continue;
            const out = openAIDeltaToAnthropicSse(parsed, state);
            if (out) controller.enqueue(encoder.encode(out));
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

/* -------------------------------- /v1/models -------------------------------- */

async function handleModels(req: Request, config: AppConfig): Promise<Response> {
  // The Anthropic-format `/v1/models` requires:
  //  - `id` contains "claude" or "anthropic" (case-insensitive) — Claude Code
  //    client filters out anything that doesn't, so non-claude aliases must be
  //    transformed to e.g. "claude-gpt-5" to surface in the picker.
  //  - Optional `display_name` (label), `description`, `created_at` (ISO 8601).
  //  - The bare OpenAI list is the default for direct OpenAI clients, but
  //    Claude Code v2.1.129+ opts in via CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
  // Default format is "anthropic" — that's what Claude Code v2.1.129+ expects
  // when using gateway discovery, and the only cost of the prefix is one
  // string-rewrite on the way back. Pass ?format=openai for the raw OpenAI
  // shape if you need it for other clients.
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "anthropic";

  const providers = resolveProviders(config);
  const models = config.models ?? [];
  const baseData = models
    .filter((m: ModelAlias) => !m.hidden)
    .map((m: ModelAlias) => {
      const provider = providers.find((p) => p.id === m.provider);
      return {
        publicName: m.name,
        upstreamId: m.modelId,
        providerId: provider?.id ?? "anthropic",
        label: m.label,
      };
    });

  // Live discovery for ?refresh=1
  if (url.searchParams.get("refresh") === "1") {
    await Promise.all(
      providers
        .filter((p) => p.type === "openai")
        .map(async (p) => {
          try {
            const live = await fetchModelList(p);
            for (const id of live) {
              if (id === "__passthrough__") continue;
              if (baseData.some((d) => d.publicName === id)) continue;
              baseData.push({ publicName: id, upstreamId: id, providerId: p.id, label: undefined });
            }
          } catch (e) {
            log(config, `discovery failed for ${p.id}: ${(e as Error).message}`);
          }
        }),
    );
  }

  const data = baseData.map((d) => {
    if (format === "anthropic") {
      const id = /claude|anthropic/i.test(d.publicName) ? d.publicName : `claude-${d.publicName}`;
      return {
        id,
        type: "model",
        display_name: d.label ?? d.publicName,
        description: `Routed via claude-proxy: ${d.upstreamId} (${d.providerId})`,
        created_at: "2025-01-01T00:00:00Z",
      };
    }
    return {
      id: d.publicName,
      object: "model",
      created: 0,
      owned_by: d.providerId,
      display_name: d.label ?? d.publicName,
    };
  });

  const body = format === "anthropic" ? { data } : { object: "list", data };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* --------------------------------- helpers --------------------------------- */

async function handleCountTokens(req: Request): Promise<Response> {
  let body: AnthropicMessagesBody;
  try {
    body = (await req.json()) as AnthropicMessagesBody;
  } catch (e) {
    return anthropicError(400, "invalid_request_error", `Invalid JSON: ${(e as Error).message}`);
  }
  // Rough estimate; honest about being approximate.
  const tokens = estimateTokens(body);
  return new Response(JSON.stringify({ input_tokens: tokens }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function estimateTokens(body: AnthropicMessagesBody): number {
  let chars = 0;
  if (typeof body.system === "string") chars += body.system.length;
  else if (Array.isArray(body.system)) chars += body.system.map((b) => b.text ?? "").join("").length;
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") chars += msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "text" && b.text) chars += b.text.length;
        else if (b.type === "image") chars += 1000; // rough per-image cost
        else if (b.type === "tool_result") {
          if (typeof b.content === "string") chars += b.content.length;
          else if (Array.isArray(b.content)) chars += b.content.map((c) => c.text ?? "").join("").length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

function buildUpstreamHeaders(req: Request, provider: ResolvedProvider): Headers {
  const out = new Headers();
  req.headers.forEach((value, name) => {
    if (STRIPPED_REQUEST_HEADERS[name.toLowerCase()]) return;
    out.set(name, value);
  });
  if (provider.headers) {
    for (const [k, v] of Object.entries(provider.headers)) out.set(k, v);
  }
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 600_000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function copyResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!STRIPPED_RESPONSE_HEADERS[k.toLowerCase()]) headers.set(k, v);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

function translateOpenAIError(upstream: Response, text: string): Response {
  let type = "api_error";
  // Detect HTML error pages (Cloudflare 502, gateway errors, etc.) and
  // produce a clean message instead of dumping the full page into the body.
  const isHtml = /^\s*<!doctype html|<html/i.test(text);
  if (isHtml) {
    const firstHeading = /<h1[^>]*>([^<]+)/i.exec(text)?.[1]?.trim();
    const status = `${upstream.status}${upstream.statusText ? " " + upstream.statusText : ""}`;
    const message = firstHeading
      ? `upstream returned HTML error page (${status}): ${firstHeading}`
      : `upstream returned HTML error page (${status})`;
    return anthropicError(upstream.status, "api_error", message);
  }
  let message = text || `upstream error ${upstream.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } };
    if (parsed.error?.message) message = parsed.error.message;
    if (parsed.error?.type) type = parsed.error.type;
  } catch { /* keep raw */ }
  return anthropicError(upstream.status, type, message);
}

export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  const p = path.replace(/^\//, "");
  return `${b}/${p}`;
}

function log(config: AppConfig, msg: string): void {
  if (config.logLevel === "silent") return;
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

/* --------------------------------- admin --------------------------------- */

async function handleAdmin(req: Request, config: AppConfig, path: string): Promise<Response> {
  if (path === "/admin/providers" && req.method === "GET") {
    return new Response(JSON.stringify(config.providers), { headers: { "content-type": "application/json" } });
  }
  if (path === "/admin/providers" && req.method === "POST") {
    const body = (await req.json()) as Partial<ProviderConfig>;
    if (!body.id || !body.type || !body.baseUrl) {
      return anthropicError(400, "invalid_request_error", "id, type, baseUrl required");
    }
    const { upsertProvider } = await import("./config/config.ts");
    upsertProvider(body as ProviderConfig);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }  const providerDel = /^\/admin\/providers\/([^/]+)$/.exec(path);
  if (providerDel && providerDel[1] && req.method === "DELETE") {
    const { removeProvider } = await import("./config/config.ts");
    removeProvider(decodeURIComponent(providerDel[1]));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  if (path === "/admin/models" && req.method === "GET") {
    return new Response(JSON.stringify(config.models), { headers: { "content-type": "application/json" } });
  }
  if (path === "/admin/models" && req.method === "POST") {
    const body = (await req.json()) as Partial<ModelAlias>;
    if (!body.name || !body.provider || !body.modelId) {
      return anthropicError(400, "invalid_request_error", "name, provider, modelId required");
    }
    const { upsertModel } = await import("./config/config.ts");
    upsertModel(body as ModelAlias);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  const modelDel = /^\/admin\/models\/([^/]+)$/.exec(path);
  if (modelDel && modelDel[1] && req.method === "DELETE") {
    const { removeModel } = await import("./config/config.ts");
    removeModel(decodeURIComponent(modelDel[1]));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  if (path === "/admin/discover" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { provider?: string };
    if (!body.provider) return anthropicError(400, "invalid_request_error", "provider required");
    const p = resolveProviders(config).find((x) => x.id === body.provider);
    if (!p) return anthropicError(404, "not_found_error", `unknown provider ${body.provider}`);
    try {
      const ids = await discoverModelsForProvider(p);
      return new Response(JSON.stringify({ provider: p.id, models: ids }), { headers: { "content-type": "application/json" } });
    } catch (e) {
      return anthropicError(502, "api_error", (e as Error).message);
    }
  }
  return anthropicError(404, "not_found_error", "admin route not found");
}

async function serveDashboard(): Promise<Response> {
  // Try the bundled embedded asset first (single-file binary mode).
  // Bun's --asset embeds files under the path passed. The asset name is
  // derived from the source path: src/web/index.html → something like
  // "index.html-<hash>.html" (we set --asset-naming for stability below).
  const candidates = [
    // Bun-asset style: source path preserved
    "src/web/index.html",
    "./web/index.html",
    // Local dev (running via `bun src/cli.ts` from project root)
    new URL("./web/index.html", import.meta.url),
    new URL("../src/web/index.html", import.meta.url),
    new URL("../web/index.html", import.meta.url),
  ];
  for (const c of candidates) {
    const file = Bun.file(c);
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
  }
  return new Response(
    "dashboard not bundled with this build. Re-run `bun run build:bin:windows` from source, or check the asset embed flag.",
    { status: 500 },
  );
}
