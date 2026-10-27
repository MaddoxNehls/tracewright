/**
 * Normalizes recorded LLM payloads into a chat transcript for the inspector.
 * Handles Anthropic Messages-style payloads (content blocks) and
 * OpenAI-compatible ones (string content, choices[0].message). Anything
 * unrecognized falls back to a raw JSON block rather than disappearing.
 */
import type { JsonValue } from "./types";

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: JsonValue }
  | { type: "tool_result"; content: string; isError: boolean }
  | { type: "json"; value: JsonValue };

export interface ChatMessage {
  role: string;
  blocks: ChatBlock[];
}

export interface Transcript {
  system: string | null;
  messages: ChatMessage[];
  response: ChatMessage | null;
  stopReason: string | null;
}

type JsonObject = { [key: string]: JsonValue };

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function textOf(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : textOf(part))).join("\n");
  if (v == null) return "";
  return JSON.stringify(v, null, 2);
}

function toBlock(block: JsonValue): ChatBlock {
  if (typeof block === "string") return { type: "text", text: block };
  if (isObject(block)) {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "tool_use") return { type: "tool_use", name: String(block.name ?? "tool"), input: block.input ?? null };
    if (block.type === "tool_result") return { type: "tool_result", content: textOf(block.content), isError: block.is_error === true };
  }
  return { type: "json", value: block };
}

function toBlocks(content: JsonValue | undefined): ChatBlock[] {
  if (content == null) return [];
  if (Array.isArray(content)) return content.map(toBlock);
  return [toBlock(content)];
}

function toMessage(m: JsonValue): ChatMessage {
  if (!isObject(m)) return { role: "unknown", blocks: [toBlock(m)] };
  const blocks = toBlocks(m.content);
  // OpenAI-style assistant tool calls live beside content, not inside it.
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      const fn = isObject(call) && isObject(call.function) ? call.function : null;
      if (fn) blocks.push({ type: "tool_use", name: String(fn.name ?? "tool"), input: parseMaybeJson(fn.arguments) });
    }
  }
  return { role: typeof m.role === "string" ? m.role : "unknown", blocks };
}

function parseMaybeJson(v: JsonValue | undefined): JsonValue {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v) as JsonValue;
  } catch {
    return v;
  }
}

export function toTranscript(input: JsonValue, output: JsonValue): Transcript {
  let system: string | null = null;
  let messages: ChatMessage[] = [];

  if (isObject(input)) {
    if (input.system != null) system = textOf(input.system) || null;
    if (Array.isArray(input.messages)) {
      for (const m of input.messages) {
        // OpenAI puts the system prompt in the message list.
        if (isObject(m) && m.role === "system" && system === null) system = textOf(m.content);
        else messages.push(toMessage(m));
      }
    }
  } else if (Array.isArray(input)) {
    messages = input.map(toMessage);
  } else if (typeof input === "string") {
    messages = [{ role: "user", blocks: [{ type: "text", text: input }] }];
  }

  let response: ChatMessage | null = null;
  let stopReason: string | null = null;
  if (isObject(output)) {
    const choice = Array.isArray(output.choices) && isObject(output.choices[0]) ? output.choices[0] : null;
    if (choice) {
      response = isObject(choice.message) ? toMessage(choice.message) : null;
      stopReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    } else {
      response = { role: typeof output.role === "string" ? output.role : "assistant", blocks: toBlocks(output.content) };
      stopReason = typeof output.stop_reason === "string" ? output.stop_reason : null;
    }
  } else if (typeof output === "string") {
    response = { role: "assistant", blocks: [{ type: "text", text: output }] };
  }

  return { system, messages, response, stopReason };
}
