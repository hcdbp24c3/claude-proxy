/**
 * Anthropic Messages request -> OpenAI Chat Completions request.
 *
 * Supports:
 *  - system, user, assistant messages
 *  - tool_use / tool_result blocks
 *  - image blocks (base64 + url)
 *  - tools[] (mapped to OpenAI functions / tools)
 *  - stream / non-stream
 *
 * Does NOT currently support: thinking blocks, prompt caching, citations,
 * document blocks (skipped with a marker). All of those are added as the
 * upstream APIs stabilise.
 */

export interface AnthropicMessagesBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  [k: string]: unknown;
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;
export interface AnthropicUserMessage { role: "user"; content: string | AnthropicContentBlock[]; }
export interface AnthropicAssistantMessage { role: "assistant"; content: string | AnthropicContentBlock[]; }

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: "base64" | "url"; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  user?: string;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | UserContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface UserContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAITool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface OpenAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** Translate. The output is plain JSON; the caller may stringify it. */
export function anthropicToOpenAI(
  body: AnthropicMessagesBody,
  upstreamModel: string,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else {
      const text = body.system
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  for (const msg of body.messages) {
    if (msg.role === "user") {
      messages.push(...userToOpenAIMessages(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(...assistantToOpenAIMessages(msg.content));
    }
  }

  const out: OpenAIChatRequest = { model: upstreamModel, messages, stream: body.stream === true };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (body.metadata?.user_id) out.user = body.metadata.user_id;

  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (body.tool_choice) {
    out.tool_choice = translateToolChoice(body.tool_choice);
  }
  return out;
}

type UserContentPartInternal =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function userToOpenAIMessages(content: AnthropicContentBlock[] | string): OpenAIMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  // Group text into a single user message; convert each image to its own
  // content part; pair each tool_result with a tool-role message.
  const out: OpenAIMessage[] = [];
  const parts: UserContentPartInternal[] = [];
  const flushParts = () => {
    if (parts.length === 0) return;
    out.push({ role: "user", content: parts });
    parts.length = 0;
  };
  const pushText = (text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === "text") {
      last.text += text;
    } else {
      parts.push({ type: "text", text });
    }
  };
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      pushText(block.text);
    } else if (block.type === "image" && block.source) {
      if (block.source.type === "base64" && block.source.data) {
        const mt = block.source.media_type ?? "image/png";
        parts.push({ type: "image_url", image_url: { url: `data:${mt};base64,${block.source.data}` } });
      } else if (block.source.type === "url" && block.source.url) {
        parts.push({ type: "image_url", image_url: { url: block.source.url } });
      }
    } else if (block.type === "tool_result") {
      flushParts();
      const result = toolResultToString(block.content);
      out.push({
        role: "tool",
        tool_call_id: block.id ?? `toolu_${out.length}`,
        content: block.is_error ? `[error] ${result}` : result,
      });
    }
  }
  flushParts();
  return out;
}

function assistantToOpenAIMessages(content: AnthropicContentBlock[] | string): OpenAIMessage[] {
  if (typeof content === "string") {
    return [{ role: "assistant", content }];
  }
  let text = "";
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const out: OpenAIMessage = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return [out];
}

function toolResultToString(content: AnthropicContentBlock[] | string | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" && typeof b.text === "string") ? b.text : "")
    .filter(Boolean)
    .join("\n");
}

function translateToolChoice(choice: AnthropicToolChoice): unknown {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return undefined;
}
