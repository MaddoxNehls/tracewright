import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { init, instrumentAnthropic, instrumentOpenAI, run, shutdown } from "../src/index.ts";
import { InMemoryExporter } from "../src/testing.ts";

let recorder: InMemoryExporter;

beforeEach(() => {
  recorder = new InMemoryExporter();
  init({ exporter: recorder });
});

afterEach(() => shutdown());

/** Mimics the SDKs' APIPromise: a Promise subclass with extra methods callers rely on. */
class FakeAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<{ data: T; requestId: string }> {
    return this.then((data) => ({ data, requestId: "req_123" }));
  }
}

const anthropicMessage = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Paris." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 3 },
};

function fakeAnthropic(respond: (params: Record<string, unknown>) => Promise<unknown> = async () => anthropicMessage) {
  return {
    messages: {
      calls: 0,
      create(params: Record<string, unknown>) {
        this.calls++;
        return FakeAPIPromise.resolve(undefined).then(() => respond(params)) as Promise<unknown>;
      },
    },
  };
}

describe("instrumentAnthropic", () => {
  it("records an llm span with GenAI attributes, input and output", async () => {
    const client = instrumentAnthropic(fakeAnthropic());
    const params = {
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      temperature: 0.2,
      system: "Be terse.",
      messages: [{ role: "user", content: "Capital of France?" }],
    };

    const response = await run("agent", () => client.messages.create(params));

    expect(response).toBe(anthropicMessage);
    const [llm] = recorder.byName("chat claude-sonnet-4-5");
    const [root] = recorder.roots();
    expect(llm).toMatchObject({
      kind: "llm",
      status: "ok",
      parent_span_id: root?.span_id,
      attributes: {
        "gen_ai.provider.name": "anthropic",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-sonnet-4-5",
        "gen_ai.request.max_tokens": 256,
        "gen_ai.request.temperature": 0.2,
        "gen_ai.response.model": "claude-sonnet-4-5-20250929",
        "gen_ai.response.id": "msg_01",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 3,
        "gen_ai.response.finish_reasons": ["end_turn"],
      },
      input: { system: "Be terse.", messages: params.messages },
      output: { role: "assistant", content: anthropicMessage.content },
    });
  });

  it("returns the SDK's own promise so extra methods keep working", async () => {
    const withExtras = {
      messages: { create: () => new FakeAPIPromise<typeof anthropicMessage>((resolve) => resolve(anthropicMessage)) },
    };
    const original = withExtras.messages.create;
    const client = instrumentAnthropic(withExtras);
    expect(client.messages.create).not.toBe(original);

    const pending = client.messages.create();
    expect(pending).toBeInstanceOf(FakeAPIPromise);
    await expect(pending.withResponse()).resolves.toEqual({ data: anthropicMessage, requestId: "req_123" });
    expect(recorder.spans).toHaveLength(1);
  });

  it("records API errors and rethrows them unchanged", async () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
    }
    const failure = new RateLimitError("429 rate limited");
    const client = instrumentAnthropic(
      fakeAnthropic(async () => {
        throw failure;
      }),
    );

    await expect(client.messages.create({ model: "claude-haiku-4-5" })).rejects.toBe(failure);
    expect(recorder.spans[0]).toMatchObject({
      kind: "llm",
      status: "error",
      error: { type: "RateLimitError", message: "429 rate limited" },
    });
  });

  it("records synchronous throws from create", () => {
    const client = instrumentAnthropic({
      messages: {
        create: () => {
          throw new TypeError("bad params");
        },
      },
    });
    expect(() => client.messages.create()).toThrow("bad params");
    expect(recorder.spans[0]?.status).toBe("error");
  });

  it("passes streaming calls through untraced", async () => {
    const client = instrumentAnthropic(fakeAnthropic());
    await client.messages.create({ model: "m", stream: true });
    expect(recorder.spans).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const client = fakeAnthropic();
    instrumentAnthropic(instrumentAnthropic(client));
    await client.messages.create({ model: "m" });
    expect(recorder.spans).toHaveLength(1);
    expect(client.messages.calls).toBe(1);
  });

  it("never lets a malformed response break the host call", async () => {
    const client = instrumentAnthropic(fakeAnthropic(async () => "not an object"));
    await expect(client.messages.create({ model: "m" })).resolves.toBe("not an object");
    expect(recorder.spans[0]).toMatchObject({ status: "ok", output: { role: "assistant", content: null } });
  });

  it("parents concurrent calls to the span that made them", async () => {
    const client = instrumentAnthropic(fakeAnthropic());
    await run("agent", async (root) => {
      await Promise.all([client.messages.create({ model: "a" }), client.messages.create({ model: "b" })]);
      expect(recorder.childrenOf(root.spanId)).toHaveLength(2);
    });
  });
});

describe("instrumentOpenAI", () => {
  const completion = {
    id: "gen-abc",
    model: "anthropic/claude-sonnet-4.5",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Paris." } }],
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
  };

  function fakeOpenAI(response: unknown = completion) {
    return { chat: { completions: { create: vi.fn(async (_params: Record<string, unknown>) => response) } } };
  }

  it("maps chat completions onto GenAI attributes with a custom provider", async () => {
    const client = instrumentOpenAI(fakeOpenAI(), { provider: "openrouter" });
    const messages = [{ role: "user", content: "Capital of France?" }];

    await client.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      max_completion_tokens: 64,
      messages,
    });

    expect(recorder.spans[0]).toMatchObject({
      name: "chat anthropic/claude-sonnet-4.5",
      kind: "llm",
      attributes: {
        "gen_ai.provider.name": "openrouter",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "anthropic/claude-sonnet-4.5",
        "gen_ai.request.max_tokens": 64,
        "gen_ai.response.model": "anthropic/claude-sonnet-4.5",
        "gen_ai.response.id": "gen-abc",
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 2,
        "gen_ai.response.finish_reasons": ["stop"],
      },
      input: { messages },
      output: { role: "assistant", content: "Paris." },
    });
  });

  it("defaults the provider to openai and records every choice when n > 1", async () => {
    const twoChoices = {
      ...completion,
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "A" } },
        { index: 1, finish_reason: "length", message: { role: "assistant", content: "B" } },
      ],
    };
    const client = instrumentOpenAI(fakeOpenAI(twoChoices));
    await client.chat.completions.create({ model: "gpt-5", n: 2 });

    const [llm] = recorder.spans;
    expect(llm?.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(llm?.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop", "length"]);
    expect(llm?.output).toHaveLength(2);
  });

  it("omits attributes the response does not carry", async () => {
    const client = instrumentOpenAI(fakeOpenAI({ choices: [] }));
    await client.chat.completions.create({ model: "local" });
    expect(Object.keys(recorder.spans[0]?.attributes ?? {}).sort()).toEqual([
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
    ]);
  });
});

describe("real SDK clients (types and patching only; no requests are made)", () => {
  it("accepts an Anthropic client and preserves its type", () => {
    const client = instrumentAnthropic(new Anthropic({ apiKey: "sk-test-not-used" }));
    expectTypeOf(client).toEqualTypeOf<Anthropic>();
    expect(Object.getOwnPropertySymbols(client.messages.create)).toContain(Symbol.for("tracewright.instrumented"));
  });

  it("accepts an OpenAI client pointed at OpenRouter", () => {
    const client = instrumentOpenAI(
      new OpenAI({ apiKey: "sk-test-not-used", baseURL: "https://openrouter.ai/api/v1" }),
      { provider: "openrouter" },
    );
    expectTypeOf(client).toEqualTypeOf<OpenAI>();
    expect(Object.getOwnPropertySymbols(client.chat.completions.create)).toContain(
      Symbol.for("tracewright.instrumented"),
    );
  });
});
