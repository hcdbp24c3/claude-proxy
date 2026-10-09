/**
 * Comprehensive e2e test against the real dc-ai.dabeecao.org API.
 * Run with: DC_AI_KEY="dc_..." bun test/e2e-real.ts
 */
import { startProxyServer } from "../src/server.ts";
import type { AppConfig } from "../src/types.ts";
import { readFileSync } from "node:fs";

const proxyPort = 8765;
const cfgPath = process.env.CLAUDE_PROXY_CONFIG ?? "/tmp/dc-config.json";
const config: AppConfig = JSON.parse(readFileSync(cfgPath, "utf8")) as AppConfig;

const server = await startProxyServer(config, { port: proxyPort });
const url = `http://127.0.0.1:${proxyPort}`;
console.log(`proxy: ${url}`);
console.log(`models: ${config.models.length}`);

let pass = 0, fail = 0;
async function test(name: string, fn: () => Promise<void>, timeoutMs = 60000) {
  process.stdout.write(`  ${name} ... `);
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    process.stdout.write("ok\n");
    pass++;
  } catch (e) {
    process.stdout.write(`FAIL\n    ${(e as Error).message}\n`);
    fail++;
  }
}

// 1. Health & dashboard
await test("healthz", async () => {
  const r = await fetch(`${url}/healthz`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
});

await test("/v1/models returns all aliases", async () => {
  const r = await fetch(`${url}/v1/models`);
  const j = (await r.json()) as { data: Array<{ id: string }> };
  if (j.data.length !== config.models.length) {
    throw new Error(`expected ${config.models.length} models, got ${j.data.length}`);
  }
});

await test("/ (dashboard HTML)", async () => {
  const r = await fetch(`${url}/`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const t = await r.text();
  if (!t.includes("<!doctype html>")) throw new Error("not HTML");
});

// 2. Non-stream across diverse model families
const sampleModels = [
  ["claude-sonnet-4-6", "Anthropic"],
  ["claude-opus-4-6", "Anthropic flagship"],
  ["gpt-6-sol", "OpenAI"],
  ["gpt-6-luna", "OpenAI"],
  ["deepseek-v4-flash", "DeepSeek"],
  ["gemini-3.8-flash", "Google"],
  ["grok-4.6", "xAI"],
  ["glm-5.3-flash", "Zhipu"],
  ["agnes-3.0-flash", "Agnes"],
  ["ling-3.1-flash", "Ling"],
  ["longcat-2.5-preview", "LongCat"],
  ["mimo-v2.6-flash", "Xiaomi"],
  ["step-5-preview", "StepFun"],
  ["muse-spark-1.3-contributor", "Muse"],
];

for (const [model, family] of sampleModels) {
  await test(`non-stream ${model} (${family})`, async () => {
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with just the word: OK" }],
      }),
    });
    if (r.status !== 200) {
      const t = await r.text();
      throw new Error(`status ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = (await r.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
    const text = j.content[0]?.text;
    if (!text || text.length === 0) throw new Error("empty content");
    if (j.stop_reason !== "end_turn" && j.stop_reason !== "max_tokens") {
      throw new Error(`stop_reason: ${j.stop_reason}`);
    }
  });
}

// 3. Streaming
await test("stream claude-sonnet-4-6", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Count: one, two, three" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.headers.get("content-type")?.includes("event-stream")) {
    throw new Error("not SSE");
  }
  const text = await r.text();
  for (const evt of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
    if (!text.includes(`event: ${evt}`)) throw new Error(`missing ${evt}`);
  }
  // Must contain at least the text fragments
  if (!text.includes("one") || !text.includes("two") || !text.includes("three")) {
    throw new Error("streamed text missing");
  }
}, 120_000);

await test("stream gpt-6-sol", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-sol",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Count: a, b, c" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const text = await r.text();
  if (!text.includes("event: message_start")) throw new Error("no start");
  if (!text.includes("event: message_stop")) throw new Error("no stop");
}, 120_000);

// 4. Tool use
await test("tool_use roundtrip", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      tools: [{
        name: "get_weather",
        description: "Get the current weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      messages: [{ role: "user", content: "What's the weather in Hanoi?" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { content: Array<{ type: string; name?: string; input?: { city?: string } }>; stop_reason: string };
  const tool = j.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error(`no tool_use: ${JSON.stringify(j.content)}`);
  if (tool.name !== "get_weather") throw new Error(`wrong name: ${tool.name}`);
  if (!tool.input?.city) throw new Error(`no city`);
  if (j.stop_reason !== "tool_use") throw new Error(`stop_reason: ${j.stop_reason}`);
});

// 5. Multi-turn with tool result
await test("multi-turn with tool_result", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      tools: [{
        name: "add",
        description: "Add two numbers",
        input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      }],
      messages: [
        { role: "user", content: "What is 17 + 25?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "add", input: { a: 17, b: 25 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "42" }] },
      ],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
  const text = j.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("no text");
  if (!text.includes("42")) throw new Error(`answer missing 42: ${text}`);
});

// 6. System prompt
await test("system prompt respected", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 30,
      system: "You only ever reply with a single word: PINEAPPLE. Never anything else.",
      messages: [{ role: "user", content: "What fruit am I thinking of?" }],
    }),
  });
  const j = (await r.json()) as { content: Array<{ type: string; text?: string }> };
  const text = j.content[0]?.text ?? "";
  if (!text.toLowerCase().includes("pineapple")) {
    throw new Error(`expected PINEAPPLE, got: ${text.slice(0, 100)}`);
  }
});

// 7. Error handling
await test("unknown model returns 404", async () => {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "this-model-does-not-exist-xyz",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
});

await test("upstream error translated", async () => {
  // Empty messages should give 400-ish
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [] }),
  });
  if (r.status >= 200 && r.status < 300) {
    // Some upstreams tolerate empty; not a fail
    return;
  }
  if (r.status >= 500) throw new Error(`server error: ${r.status}`);
});

// 8. count_tokens
await test("count_tokens returns number", async () => {
  const r = await fetch(`${url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello world" }],
    }),
  });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const j = (await r.json()) as { input_tokens: number };
  if (typeof j.input_tokens !== "number" || j.input_tokens < 1) {
    throw new Error(`bad tokens: ${j.input_tokens}`);
  }
});

// 9. Refresh models
await test("GET /v1/models?refresh=1 merges live list", async () => {
  const r = await fetch(`${url}/v1/models?refresh=1`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const j = (await r.json()) as { data: Array<{ id: string }> };
  if (j.data.length < config.models.length) {
    throw new Error(`lost models: was ${config.models.length}, got ${j.data.length}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
server.stop();
process.exit(fail > 0 ? 1 : 0);
