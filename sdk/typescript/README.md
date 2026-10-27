# tracewright (TypeScript SDK)

A flight recorder for AI agents. Wrap your agent once, and every run is recorded as a
tree of spans (the run, each LLM call, each tool call) and shipped in the background to the
Tracewright ingest service, where you can inspect, diff, and replay it.

- **Zero runtime dependencies.** Uses Node's `fetch`, `zlib`, and `AsyncLocalStorage`.
- **Safe for the host.** It never throws into your code and never keeps your process alive,
  and if the backend is down it drops spans (and counts them) instead of growing memory.
- **Interoperable.** Attributes follow the OpenTelemetry GenAI semantic conventions.
- **ESM + CommonJS**, fully typed, Node 20+.

## Install

```sh
pnpm add tracewright
```

`@anthropic-ai/sdk` and `openai` are optional peer dependencies. Tracewright never imports
them at runtime; it only wraps clients you pass in.

## Quick start

```ts
import Anthropic from "@anthropic-ai/sdk";
import { init, instrumentAnthropic, run, trace } from "tracewright";

init(); // reads TRACEWRIGHT_API_KEY and TRACEWRIGHT_ENDPOINT (default http://localhost:4318)

const client = instrumentAnthropic(new Anthropic());

const search = trace(async (query: string) => searchWeb(query), { kind: "tool", name: "search" });

const answer = await run(
  "research",
  async () => {
    const hits = await search("flight recorders");
    const reply = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: `Summarise: ${hits}` }],
    });
    return reply.content;
  },
  { tags: ["demo"], input: "flight recorders" },
);
```

That run is recorded as:

```
agent  research
  tool   search
  llm    chat claude-sonnet-4-5   (model, tokens, finish reason, prompt, response)
```

Without an API key the SDK is a **silent no-op**: your code runs unchanged and nothing is sent.

Run the offline example (fake LLM client, no network, prints the span tree):

```sh
pnpm example
```

## API

| | |
|---|---|
| `init({ apiKey?, endpoint?, exporter?, batchSize?, flushIntervalMs?, maxQueueSize? })` | Configure the SDK. Calling it again flushes and replaces the previous exporter. |
| `run(name, fn, { tags?, input?, attributes? })` | Start a run: a root `agent` span with a new trace id. Returns `fn`'s result. |
| `span(name, fn, { kind?, input?, attributes? })` | A manual child span of the current span. |
| `trace(fn, { kind?, name?, captureInput?, captureOutput? })` | Wrap a function so every call is a span. Keeps `fn`'s type and `this`. |
| `instrumentAnthropic(client)` | Record `client.messages.create` calls as `llm` spans. |
| `instrumentOpenAI(client, { provider? })` | Record `client.chat.completions.create` calls. Use `provider: "openrouter"` for gateways. |
| `getCurrentSpan()` | The active `Span`, if any. |
| `flush(timeoutMs?)` / `shutdown(timeoutMs?)` | Deliver queued spans. Neither ever rejects. |
| `stats()` | `{ exported, droppedQueueFull, failed }` counters. |

`fn` receives the active `Span`, which has `setAttribute`, `setAttributes`, `setInput`,
`setOutput`, `setError`, and `recordException`. A return value is recorded as the span's
output unless you called `setOutput` yourself. Errors mark the span `error` and are
rethrown unchanged.

### Context propagation

The current span is held in `AsyncLocalStorage`, so it follows the logical call chain
through `await`, timers, and callbacks. Concurrent branches get the right parents with no
extra code:

```ts
await run("agent", () =>
  Promise.all(queries.map((q) => span(`research ${q}`, () => search(q)))),
);
```

### Testing your agent

```ts
import { init } from "tracewright";
import { InMemoryExporter } from "tracewright/testing";

const recorder = new InMemoryExporter();
init({ exporter: recorder });
// ... run your agent ...
expect(recorder.byName("search")).toHaveLength(2);
```

## How export works

- `export` pushes onto a bounded in-memory buffer (2048 spans by default). When the buffer
  is full, new spans are dropped and counted in `stats().droppedQueueFull`.
- A batch goes out when 100 spans are waiting or the oldest has waited 1 s. Batches are
  gzipped JSON `POST`ed to `/v1/spans` with `Authorization: Bearer <key>`.
- Network errors, `429`, and `5xx` are retried with exponential backoff and full jitter,
  honouring `Retry-After`. Ingest is idempotent on `(trace_id, span_id)`, so retries are
  safe. Other `4xx` responses are permanent and logged once per batch.
- Every timer is `unref`'d. When the event loop drains, a `beforeExit` hook flushes pending
  spans for up to 2 s. On `process.exit()` or a signal, call `await shutdown()` first.
- `input` and `output` are snapshotted when set (later mutation is not recorded) and safely
  serialized: circular refs, `BigInt`, `Error` (with `cause`), `Map`, `Set`, `Date`, typed
  arrays, and throwing getters all serialize without throwing. Payloads over 256 KB are cut to a
  JSON prefix and the span gets `tracewright.truncated: true`.

## Limitations

- Streaming LLM calls (`stream: true`) pass through untraced for now.
- An instrumented call observes the SDK's response promise. If you call `.asResponse()` and
  read the raw body yourself, the SDK may already have consumed it.
- Node only (it relies on `AsyncLocalStorage` and `zlib`).

## Development

```sh
pnpm install
pnpm typecheck   # tsc, strict mode with exactOptionalPropertyTypes
pnpm lint        # biome
pnpm test        # vitest
pnpm build       # tsup: ESM + CJS + .d.ts
```

TypeScript is pinned to 6.x because tsup's declaration build uses the compiler API, which
the native TypeScript 7 doesn't ship.
