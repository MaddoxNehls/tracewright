/** Auto-instrumentation for OpenAI-compatible chat completion clients (OpenAI, OpenRouter, ...). */

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

/** The slice of an OpenAI client that instrumentation touches. */
export interface OpenAIClientLike {
  chat: { completions: { create: AnyFunction } };
}

export interface InstrumentOpenAIOptions {
  /** `gen_ai.provider.name` for the spans, e.g. "openrouter" for a gateway. Default "openai". */
  provider?: string;
}

function openAIAdapter(provider: string): LlmAdapter {
  return {
    describeRequest(params) {
      const model = readString(params, "model");
      return {
        name: chatSpanName(model),
        attributes: compact({
          "gen_ai.provider.name": provider,
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": model,
          "gen_ai.request.max_tokens": readNumber(params, "max_tokens") ?? readNumber(params, "max_completion_tokens"),
          "gen_ai.request.temperature": readNumber(params, "temperature"),
        }),
        input: compact({ messages: params["messages"], tools: params["tools"] }),
      };
    },

    recordResponse(span, response) {
      const usage = read(response, "usage");
      const rawChoices = read(response, "choices");
      const choices: unknown[] = Array.isArray(rawChoices) ? rawChoices : [];
      const finishReasons = choices
        .map((choice) => readString(choice, "finish_reason"))
        .filter((reason) => reason !== undefined);
      span.setAttributes(
        compact({
          "gen_ai.response.model": readString(response, "model"),
          "gen_ai.response.id": readString(response, "id"),
          "gen_ai.usage.input_tokens": readNumber(usage, "prompt_tokens"),
          "gen_ai.usage.output_tokens": readNumber(usage, "completion_tokens"),
          "gen_ai.response.finish_reasons": finishReasons.length > 0 ? finishReasons : undefined,
        }),
      );
      const messages = choices.map((choice) => read(choice, "message") ?? null);
      span.setOutput(messages.length === 1 ? messages[0] : messages);
    },
  };
}

/**
 * Record every non-streaming `client.chat.completions.create` call as an `llm` span.
 * Pass `{ provider: "openrouter" }` for OpenAI-compatible gateways so spans carry the
 * right `gen_ai.provider.name`. Mutates and returns the same client.
 */
export function instrumentOpenAI<C extends OpenAIClientLike>(client: C, options: InstrumentOpenAIOptions = {}): C {
  patchCreate(client.chat.completions, openAIAdapter(options.provider ?? "openai"));
  return client;
}
