# claude-proxy

A universal proxy that lets **Claude Code CLI** and **Claude Desktop** use **any OpenAI-compatible LLM API** as a model backend, including models whose names don't start with `claude` or `anthropic`.

> The official Claude clients only accept model names that pass `^(claude|anthropic)`. This proxy registers arbitrary names — `gpt-5`, `deepseek-chat`, `gemini-pro`, `kimi-k2` — and rewrites the request to the upstream API on the way out, then translates the response back into Anthropic Messages format on the way back.

## Highlights

- **Bypass the `claude|anthropic` model-name guard** — register any upstream model as a public alias.
- **Drop-in for Claude Code CLI** and **Claude Desktop (3P / managed)**
- **Anthropic → OpenAI translation** with full streaming SSE support, tool use, images, system prompts.
- **Live model discovery** — pull the current model list from each provider and serve it on `/v1/models`.
- **Pluggable providers** — add as many `openai`-compatible or `anthropic` endpoints as you like.
- **Web dashboard** at `http://127.0.0.1:8765/` for adding providers and aliases without editing JSON.
- **Service mode** — install a systemd user unit (Linux), launchd agent (macOS), or detached background process (Windows).

## Quick start

### 1. Install

```bash
# from source
git clone https://github.com/you/claude-proxy.git
cd claude-proxy
bun install
bun run build

# or via npm (coming soon)
# npm install -g claude-proxy
```

Requires [Bun](https://bun.sh) ≥ 1.4. The bundled CLI runs from a single `dist/cli.js` file — no Node modules to install at runtime.

### 2. Configure a provider

```bash
claude-proxy init \
  --provider openrouter \
  --type openai \
  --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY \
  --model-id anthropic/claude-3.5-sonnet \
  --name openrouter-sonnet
```

Or interactively:

```bash
claude-proxy init
```

This writes `~/.claude-proxy/config.json`:

```json
{
  "bind": "127.0.0.1",
  "port": 8765,
  "providers": [
    {
      "id": "openrouter",
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  ],
  "models": [
    {
      "name": "openrouter-sonnet",
      "provider": "openrouter",
      "modelId": "anthropic/claude-3.5-sonnet"
    }
  ]
}
```

Add more aliases any time:

```bash
claude-proxy models add --name gpt-5       --provider openrouter --model-id openai/gpt-5
claude-proxy models add --name deepseek    --provider openrouter --model-id deepseek/deepseek-chat
claude-proxy models add --name kimi        --provider openrouter --model-id moonshotai/kimi-k2
```

### 3. Start the proxy

```bash
claude-proxy serve
# [2025-01-01T00:00:00Z] claude-proxy listening on http://127.0.0.1:8765
```

### 4. Wire Claude Code CLI to it

```bash
# one-shot
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_AUTH_TOKEN=claude-proxy
export ANTHROPIC_MODEL=gpt-5

# or, install into your Claude Code settings permanently
claude-proxy desktop install --target claude-code

# now use Claude Code normally — but with any model you registered
claude
```

### 5. Wire Claude Desktop to it

```bash
claude-proxy desktop install --target claude-desktop
# Restart Claude Desktop
```

This writes `~/.config/Claude-3p/configLibrary/claude-proxy.json` with:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8765",
  "inferenceGatewayApiKey": "claude-proxy"
}
```

## How the bypass works

Claude Code / Desktop only forwards requests whose `model` field matches `^(claude|anthropic)`. The proxy inverts the problem:

1. **You** register any public name in `~/.claude-proxy/config.json` — `gpt-5`, `deepseek-chat`, `kimi-k2`, `my-llama-3.3-70b`, anything.
2. **Claude Code** sends `POST /v1/messages` with `model: "gpt-5"`. The proxy accepts it (no name guard).
3. **The router** looks up `gpt-5` → `(provider=openrouter, modelId=openai/gpt-5)`.
4. **The translator** converts the Anthropic Messages request into an OpenAI Chat Completions request and POSTs it to the upstream API.
5. **The reverse translator** converts the OpenAI response (streamed SSE or JSON) back into Anthropic `message_start` / `content_block_*` / `message_delta` / `message_stop` events.
6. Claude Code renders the reply as if it came from Anthropic.

For Anthropic-native providers (the original `api.anthropic.com` or your own deployment of the Anthropic API), the proxy **forwards the request verbatim** — same headers, same body, same streaming — so features like prompt caching, extended thinking, and the latest protocol additions work without translation.

## API

| Endpoint                              | Method | Description                                          |
|---------------------------------------|--------|------------------------------------------------------|
| `POST /v1/messages`                   | POST   | Anthropic Messages API (passthrough or translated)   |
| `POST /v1/messages/count_tokens`      | POST   | Rough token estimate (chars/4)                       |
| `GET  /v1/models`                     | GET    | List configured model aliases (`?refresh=1` adds live) |
| `GET  /healthz`                       | GET    | 200 OK                                               |
| `GET  /`                              | GET    | Web dashboard (HTML)                                 |
| `GET  /admin/providers`               | GET    | List configured providers                            |
| `POST /admin/providers`               | POST   | Add / replace a provider                             |
| `DELETE /admin/providers/:id`         | DELETE | Remove a provider                                    |
| `GET  /admin/models`                  | GET    | List configured aliases                              |
| `POST /admin/models`                  | POST   | Add / replace an alias                               |
| `DELETE /admin/models/:name`          | DELETE | Remove an alias                                      |
| `POST /admin/discover`                | POST   | Pull live model list from a provider                 |

## CLI

```
claude-proxy serve [--port N] [--bind ADDR]
claude-proxy init [--provider <id> --base-url <url> --api-key-env <env>]
claude-proxy status
claude-proxy doctor
claude-proxy stop
claude-proxy env
claude-proxy desktop <install|uninstall> [--target <claude-code|claude-desktop>]
claude-proxy service <install|uninstall|start|stop|status>

claude-proxy models list
claude-proxy models add --name <alias> --provider <id> --model-id <upstream-id> [--label <text>]
claude-proxy models remove <alias>
claude-proxy models discover --provider <id>

claude-proxy provider list
claude-proxy provider add --id <id> --type <openai|anthropic> --base-url <url> [--api-key <key>] [--api-key-env <env>] [--label <text>]
claude-proxy provider remove <id>
```

## Configuration reference

```jsonc
{
  "bind": "127.0.0.1",        // listen address
  "port": 8765,                // listen port
  "logLevel": "info",          // "silent" | "info" | "debug"
  "apiKey": "optional-bearer", // if set, callers must present this token
  "defaultModel": "gpt-5",     // used when client omits model
  "providers": [
    {
      "id": "openrouter",
      "type": "openai",         // or "anthropic"
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",  // resolved at request time
      // or: "apiKey": "sk-..." for a literal key
      "headers": { "X-Tenant": "acme" },  // extra headers on every call
      "timeoutMs": 600000,
      "nativePassthrough": false          // anthropic: skip translation
    }
  ],
  "models": [
    {
      "name": "gpt-5",          // public name (no claude|anthropic required)
      "provider": "openrouter",
      "modelId": "openai/gpt-5", // upstream id
      "label": "GPT-5",
      "contextWindow": 200000,
      "hidden": false
    }
  ]
}
```

## Service management

```bash
# Linux (systemd --user)
claude-proxy service install
claude-proxy service status
claude-proxy service stop
claude-proxy service uninstall

# macOS (launchd)
claude-proxy service install

# Windows (detached bun process + pidfile)
claude-proxy service install
claude-proxy service status
```

## Provider types

| `type`       | Wire format                                | Authentication          | Notes |
|--------------|--------------------------------------------|-------------------------|-------|
| `openai`     | `POST {baseUrl}/chat/completions`          | `Authorization: Bearer` | SSE/JSON streaming, tools, images |
| `anthropic`  | `POST {baseUrl}/v1/messages`               | `x-api-key: <key>`      | Passthrough; no translation |

Any OpenAI-compatible endpoint works (OpenRouter, Together, Groq, Fireworks, DeepSeek, Ollama, LM Studio, vLLM, llama.cpp, etc.).

## Limitations

- **Thinking blocks** are not yet translated on the OpenAI ↔ Anthropic path. Anthropic-native passthrough supports them.
- **Prompt caching** works on Anthropic passthrough only.
- **Document blocks** (`type: "document"`) are stubbed with a marker on the translation path.
- **Refusals** are passed through verbatim from upstream; the proxy does not synthesise refusals.

## Project layout

```
src/
  cli.ts                          # CLI entry (serve, init, doctor, models, ...)
  server.ts                       # HTTP server: /v1/messages, /v1/models, dashboard
  router.ts                       # Public name -> (provider, upstream model)
  types.ts                        # Config + provider types
  config/config.ts                # JSON load/save, env-var expansion
  discovery/models.ts             # Live GET /v1/models from each provider
  translate/anthropic-to-openai.ts  # Request direction
  translate/openai-to-anthropic.ts  # Response direction (JSON + SSE)
  service/desktop.ts              # `claude-proxy desktop install` (Claude Code + Desktop)
  service/manager.ts              # `claude-proxy service` (systemd / launchd / pidfile)
  web/index.html                  # Dashboard

test/smoke.ts                     # End-to-end smoke test
dist/                             # `bun build` output (bundled CLI)
```

## Development

```bash
bun install
bun test/smoke.ts                 # 9 tests, all green
bun run build                     # produces dist/cli.js
bun dist/cli.js serve             # run from build
```

## License

MIT
