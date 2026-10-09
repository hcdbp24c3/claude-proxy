/**
 * OpenAI Chat Completions response -> Anthropic Messages response.
 *
 * Handles both shapes:
 *  - non-stream: full JSON `{ id, choices[].message, usage }`
 *  - stream: SSE `data: {...}` chunks + `data: [DONE]`
 *
 * Reverse translation on the way out:
 *  - choices[].message.content  -> content[].text
 *  - choices[].message.tool_calls -> content[].tool_use
 *  - finish_reason mapping:
 *      stop      -> "end_turn"
 *      length    -> "max_tokens"
 *      tool_calls -> "tool_use"
 *      content_filter / function_call -> "end_turn"
 */
import type { AnthropicContentBlock, OpenAIMessage, OpenAIToolCall } from "./anthropic-to-openai.ts";

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role: "assistant"; content?: string | null; tool_calls?: OpenAIToolCall[]; refusal?: string | null };
    delta?: { role?: "assistant"; content?: string | null; tool_calls?: OpenAIToolDelta[]; refusal?: string | null };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenAIToolDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** Convert a non-streaming OpenAI response into an Anthropic message body. */
export function openAIToAnthropicMessage(resp: OpenAIChatResponse, aliasModel: string): AnthropicMessagesResponse {
  const choice = resp.choices[0];
  if (!choice?.message) {
    return {
      id: resp.id,
      type: "message",
      role: "assistant",
      model: aliasModel,
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const blocks = messageToAnthropicBlocks(choice.message.content, choice.message.tool_calls);
  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    model: aliasModel,
    content: blocks,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

function messageToAnthropicBlocks(
  content: string | null | undefined,
  toolCalls: OpenAIToolCall[] | undefined,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  if (typeof content === "string" && content.length > 0) {
    blocks.push({ type: "text", text: content });
  }
  if (toolCalls?.length) {
    for (const call of toolCalls) {
      let input: unknown = {};
      try { input = JSON.parse(call.function.arguments); } catch { /* keep {} */ }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

function mapFinishReason(reason: string | null): AnthropicMessagesResponse["stop_reason"] {
  if (reason === "stop" || reason === null) return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return "end_turn";
}

/* --------------------------- streaming -------------------------------- */

/** Emits Anthropic SSE event strings for a single delta. Returns one
 *  or more concatenated SSE frames; the caller should write them all in
 *  order so that text deltas and content_block_stop events aren't lost
 *  when several chunks arrive in the same network read. */
export function openAIDeltaToAnthropicSse(
  chunk: OpenAIChatResponse,
  state: SseState,
): string {
  return openAIDeltaToAnthropicFrames(chunk, state).join("");
}

/** Same as above but as an array, for callers that want to inspect frames. */
export function openAIDeltaToAnthropicFrames(
  chunk: OpenAIChatResponse,
  state: SseState,
): string[] {
  const choice = chunk.choices?.[0];
  if (!choice) return [];

  // message_start fires once with the model id and empty content. If the
  // first delta also carries a `role` or initial `content` (the OpenAI
  // convention), still emit message_start *and* the content deltas —
  // callers stream every event in order.
  if (!state.started) {
    state.started = true;
    state.messageId = chunk.id;
    const head = {
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        model: chunk.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: chunk.usage?.prompt_tokens ?? 0, output_tokens: 0 },
      },
    };
    const frames: string[] = [sseFrame("message_start", head)];

    if (choice.delta?.content) {
      state.openTextIndex = state.contentBlocks.length;
      state.contentBlocks.push({ type: "text", text: "" });
      frames.push(sseFrame("content_block_start", {
        type: "content_block_start",
        index: state.openTextIndex,
        content_block: { type: "text", text: "" },
      }));
      frames.push(sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: state.openTextIndex,
        delta: { type: "text_delta", text: choice.delta.content },
      }));
    }
    return frames;
  }

  const out: string[] = [];

  if (choice.delta?.content) {
    if (state.openTextIndex < 0) {
      state.openTextIndex = state.contentBlocks.length;
      state.contentBlocks.push({ type: "text", text: "" });
      out.push(sseFrame("content_block_start", {
        type: "content_block_start",
        index: state.openTextIndex,
        content_block: { type: "text", text: "" },
      }));
    }
    out.push(sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: state.openTextIndex,
      delta: { type: "text_delta", text: choice.delta.content },
    }));
  }

  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0;
      let entry = state.openToolIndex.get(idx);
      if (!entry) {
        const blockIndex = state.contentBlocks.length;
        state.contentBlocks.push({
          type: "tool_use",
          id: tc.id ?? `toolu_${blockIndex}`,
          name: tc.function?.name ?? "",
          input: {},
        });
        entry = { blockIndex, args: "" };
        state.openToolIndex.set(idx, entry);
        out.push(sseFrame("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: tc.id ?? `toolu_${blockIndex}`, name: tc.function?.name ?? "", input: {} },
        }));
      }
      if (tc.function?.arguments) {
        entry.args += tc.function.arguments;
        out.push(sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        }));
      }
    }
  }

  if (choice.finish_reason) {
    if (state.openTextIndex >= 0) {
      out.push(sseFrame("content_block_stop", { type: "content_block_stop", index: state.openTextIndex }));
      state.openTextIndex = -1;
    }
    for (const [, entry] of state.openToolIndex) {
      out.push(sseFrame("content_block_stop", { type: "content_block_stop", index: entry.blockIndex }));
    }
    state.openToolIndex.clear();
    const stopReason = mapFinishReason(choice.finish_reason);
    out.push(sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
    }));
    out.push(sseFrame("message_stop", { type: "message_stop" }));
    state.stopped = true;
  }

  return out;
}

/** Mutable per-stream state. */
export interface SseState {
  started: boolean;
  stopped: boolean;
  messageId: string;
  contentBlocks: AnthropicContentBlock[];
  openTextIndex: number;
  openToolIndex: Map<number, { blockIndex: number; args: string }>;
}

export function newSseState(): SseState {
  return {
    started: false,
    stopped: false,
    messageId: "",
    contentBlocks: [],
    openTextIndex: -1,
    openToolIndex: new Map(),
  };
}

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Parse a single SSE `data: ...` line; returns null on `[DONE]`. */
export function parseOpenAISseLine(line: string): OpenAIChatResponse | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAIChatResponse;
  } catch {
    return null;
  }
}
