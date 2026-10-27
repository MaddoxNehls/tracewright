/** Auto-instrumentation for `@anthropic-ai/sdk` clients. */

import {
  type AnyFunction,
  chatSpanName,
  compact,
  type LlmAdapter,
  patchCreate,
  read,
  readNumber,
  readString,
} from "./common.ts";

/** The slice of an Anthropic client that instrumentation touches. */
export interface AnthropicClientLike {
  messages: { create: AnyFunction };
}

const anthropicAdapter: LlmAdapter = {
  describeRequest(params) {
    const model = readString(params, "model");
    return {
      name: chatSpanName(model),
      attributes: compact({
        "gen_ai.provider.name": "anthropic",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": model,
        "gen_ai.request.max_tokens": readNumber(params, "max_tokens"),
        "gen_ai.request.temperature": readNumber(params, "temperature"),
      }),
      input: compact({ system: params["system"], messages: params["messages"], tools: params["tools"] }),
    };
  },

  recordResponse(span, response) {
    const usage = read(response, "usage");
    const stopReason = readString(response, "stop_reason");
    span.setAttributes(
      compact({
        "gen_ai.response.model": readString(response, "model"),
        "gen_ai.response.id": readString(response, "id"),
        "gen_ai.usage.input_tokens": readNumber(usage, "input_tokens"),
        "gen_ai.usage.output_tokens": readNumber(usage, "output_tokens"),
        "gen_ai.response.finish_reasons": stopReason ? [stopReason] : undefined,
      }),
    );
    span.setOutput({ role: "assistant", content: read(response, "content") ?? null });
  },
};

/**
 * Record every non-streaming `client.messages.create` call as an `llm` span, parented to
 * the current span. Mutates and returns the same client, with its type unchanged.
 */
export function instrumentAnthropic<C extends AnthropicClientLike>(client: C): C {
  patchCreate(client.messages, anthropicAdapter);
  return client;
}
