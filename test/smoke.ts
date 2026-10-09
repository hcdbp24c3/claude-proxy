/**
 * Mock OpenAI upstream + smoke-test script.
 *
 * Spins up a tiny "upstream" that mimics the OpenAI Chat Completions API,
 * then starts claude-proxy against it, then issues a real /v1/messages
 * request and asserts the response shape.
 *
 * Run with: bun run test/smoke.ts
 */
import { startProxyServer } from "../src/server.ts";
import type { AppConfig } from "../src/types.ts";

const upstreamPort = 9988;
const proxyPort = 9987;

// 1. Mock upstream: returns canned responses.
let lastUpstreamReq: any = null;
const upstream = Bun.serve({
  port: upstreamPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/chat/completions" && req.method === "POST") {
      const body = await req.json() as any;
      lastUpstreamReq = { headers: Object.fromEntries(req.headers), body };
      const stream = body.stream === true;
      // Special upstream shape for tool-use test: client sends "call-tools",
      // mock returns a tool_call delta.
      if (body.messages?.[0]?.content === "call-tools") {
        const resp = {
          id: "x", object: "chat.completion", created: 0, model: body.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Hanoi" }) } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
        };
        return new Response(JSON.stringify(resp), { headers: { "content-type": "application/json" } });
      }
      if (stream) {
        const chunks = [
          { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
          { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
          { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        const out = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(out, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Hi there!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/models") {
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5-nano" },
          { id: "gpt-5" },
          { id: "deepseek-chat" },
        ],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`mock upstream listening on :${upstreamPort}`);

// 2. Configure proxy.
const config: AppConfig = {
  bind: "127.0.0.1",
  port: proxyPort,
  logLevel: "silent",
  providers: [
    {
      id: "mock-openai",
      type: "openai",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "sk-mock-1234",
    },
  ],
  models: [
    // The alias name deliberately does NOT start with "claude"/"anthropic".
    { name: "gpt-5", provider: "mock-openai", modelId: "gpt-5", label: "GPT-5 (mock)" },
    { name: "claude-3-5-sonnet-latest", provider: "mock-openai", modelId: "gpt-5" },
  ],
};

// 3. Start proxy.
const server = await startProxyServer(config, { port: proxyPort });
console.log(`proxy listening on :${server.port}`);

async function assert(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    process.stdout.write("ok\n");
  } catch (e) {
    process.stdout.write(`FAIL\n    ${(e as Error).message}\n`);
    process.exit(1);
  }
}

let passed = 0;

await assert("healthz", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
});

await assert("GET /v1/models lists aliases", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  const j = (await r.json()) as { data: Array<{ id: string }> };
  const ids = j.data.map((m) => m.id);
  // Default format is anthropic; non-claude aliases get a "claude-" prefix
  // injected so Claude Code's filter keeps them.
  if (!ids.includes("claude-gpt-5")) throw new Error(`claude-gpt-5 missing; got ${ids.join(",")}`);
  if (!ids.includes("claude-3-5-sonnet-latest")) throw new Error(`claude alias missing`);
});

await assert("GET /v1/models?format=openai returns raw OpenAI shape", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?format=openai`);
  const j = (await r.json()) as { object: string; data: Array<{ id: string; object: string }> };
  if (j.object !== "list") throw new Error(`object=${j.object}`);
  if (!j.data.some((m) => m.id === "gpt-5")) throw new Error(`gpt-5 missing in openai format`);
  if (!j.data.every((m) => m.object === "model")) throw new Error(`object:model missing`);
});

await assert("stripped 'claude-' prefix routes to original alias", async () => {
  lastUpstreamReq = null;
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-gpt-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  if (lastUpstreamReq?.body?.model !== "gpt-5") {
    throw new Error(`upstream model not stripped; got ${lastUpstreamReq?.body?.model}`);
  }
});

await assert("GET /admin/providers", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/admin/providers`);
  const j = (await r.json()) as Array<{ id: string }>;
  if (!j.find((p) => p.id === "mock-openai")) throw new Error(`missing provider`);
});

await assert("POST /v1/messages non-stream", async () => {
  lastUpstreamReq = null;
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",  // <-- NOT a claude/anthropic name; this is the bypass
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (r.status !== 200) {
    const t = await r.text();
    throw new Error(`status ${r.status}: ${t}`);
  }
  const j = (await r.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
  if (j.content[0]?.type !== "text" || !j.content[0]?.text?.includes("Hi")) {
    throw new Error(`unexpected body: ${JSON.stringify(j)}`);
  }
  if (lastUpstreamReq?.body?.model !== "gpt-5") {
    throw new Error(`upstream model not rewritten; got ${lastUpstreamReq?.body?.model}`);
  }
  if (!lastUpstreamReq?.headers?.authorization?.includes("sk-mock-1234")) {
    throw new Error(`upstream auth not injected: ${JSON.stringify(lastUpstreamReq?.headers)}`);
  }
});

await assert("POST /v1/messages stream (SSE)", async () => {
  lastUpstreamReq = null;
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.headers.get("content-type")?.includes("event-stream")) {
    throw new Error(`content-type: ${r.headers.get("content-type")}`);
  }
  const text = await r.text();
  for (const evt of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
    if (!text.includes(`event: ${evt}`)) throw new Error(`missing event ${evt}`);
  }
  // Anthropic splits text into separate text_delta frames; both must arrive.
  if (!text.includes('"text":"Hello"')) throw new Error(`first text delta missing`);
  if (!text.includes('"text":" world"')) throw new Error(`second text delta missing`);
});

await assert("alias of alias works (claude-* -> gpt-5)", async () => {
  lastUpstreamReq = null;
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-latest",  // <-- aliased to gpt-5 upstream
      max_tokens: 16,
      messages: [{ role: "user", content: "test" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  if (lastUpstreamReq?.body?.model !== "gpt-5") {
    throw new Error(`alias did not resolve; got ${lastUpstreamReq?.body?.model}`);
  }
});

await assert("unknown model returns 404 with helpful message", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "this-does-not-exist-xyz",
      max_tokens: 16,
      messages: [{ role: "user", content: "test" }],
    }),
  });
  if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  const j = (await r.json()) as { error: { type: string; message: string } };
  if (!j.error.message.includes("claude-proxy model add")) {
    throw new Error(`expected onboarding hint, got: ${j.error.message}`);
  }
});

await assert("count_tokens returns a number", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const j = (await r.json()) as { input_tokens: number };
  if (typeof j.input_tokens !== "number") throw new Error(`no input_tokens`);
});

await assert("tool_use roundtrip (Anthropic -> OpenAI tool_call -> Anthropic tool_use)", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "call-tools" }],
      tools: [{ name: "get_weather", description: "get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { content: Array<{ type: string; name?: string; input?: unknown }>; stop_reason: string };
  const tool = j.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error(`no tool_use block: ${JSON.stringify(j.content)}`);
  if (tool.name !== "get_weather") throw new Error(`wrong tool name: ${tool.name}`);
  if (j.stop_reason !== "tool_use") throw new Error(`stop_reason: ${j.stop_reason}`);
});

await assert("discover: live GET /v1/models with refresh=1 merges upstream list", async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?refresh=1`);
  const j = (await r.json()) as { data: Array<{ id: string }> };
  const ids = j.data.map((m) => m.id);
  for (const expected of ["claude-gpt-5-nano", "claude-gpt-5", "claude-deepseek-chat"]) {
    if (!ids.includes(expected)) throw new Error(`missing ${expected}; got ${ids.join(",")}`);
  }
});

console.log("\nall smoke tests passed");
server.stop();
upstream.stop();
