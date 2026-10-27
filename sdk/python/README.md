# tracewright (Python SDK)

Records every step of an AI agent run as a tree of spans and ships them to the
Tracewright ingest service, then lets you **replay** a recorded run with a different model
or prompt. The wire format is defined in [`docs/contract.md`](../../docs/contract.md).

## Install

```sh
uv add tracewright            # or: pip install tracewright
uv add "tracewright[anthropic]"   # extras pull in the client you instrument
```

From this repo: `uv sync` in `sdk/python`, or depend on it by path as
`examples/research-agent` does.

## Quickstart

```python
import anthropic
import tracewright

tracewright.init()  # reads TRACEWRIGHT_API_KEY, and TRACEWRIGHT_ENDPOINT (default http://localhost:4318)
client = tracewright.instrument_anthropic(anthropic.Anthropic())

@tracewright.trace(kind="tool")
def search(query: str) -> list[str]: ...

with tracewright.run("research", tags=["demo"], input=question) as run:
    for step in range(1, 9):
        with tracewright.span(f"step-{step}", attributes={"agent.step": step}):
            response = client.messages.create(model="claude-opus-5-5", ...)
            ...
    run.set_output(answer)
```

Without an API key the SDK is a silent no-op: spans are still created, so instrumented code
runs unchanged, but nothing is sent. Export happens on a background thread in gzip batches;
a full buffer drops spans (counted in `tracewright.stats()`) and never blocks or raises
into your agent.

## API

| | |
|---|---|
| `init(api_key=None, endpoint=None, *, exporter=None, ...)` | configure the exporter; call again to replace it |
| `run(name, *, tags=None, input=None, attributes=None)` | start a run: a root `agent` span with a new trace id (`with` or `async with`) |
| `span(name, *, kind="custom", input=None, attributes=None)` | a child of the current span |
| `@trace` / `@trace(kind="tool", name=None, capture_input=True, capture_output=True)` | record each call of a sync or async function; arguments become the input, the return value the output |
| `instrument_anthropic(client, provider="anthropic")` | record `client.messages.create` as `llm` spans (sync and async clients) |
| `instrument_openai(client, provider="openai")` | same for `client.chat.completions.create`; use `provider="openrouter"` for gateways |
| `get_current_span()`, `flush(timeout)`, `shutdown(timeout)`, `stats()` | |
| `replay(trace_id, *, from_step, overrides=None, tools="recorded", ...)` | re-run a recorded run; see below |
| `tracewright.testing.InMemoryExporter` | collect spans in memory for tests: `init(exporter=InMemoryExporter())` |

LLM spans follow the OpenTelemetry GenAI conventions (`gen_ai.request.model`,
`gen_ai.usage.input_tokens`, ...). Streaming calls (`stream=True`) are not recorded yet.

## Replay

Replay answers "would the new prompt (or model) have fixed this run?" It re-executes a
recorded run in your own process: steps before `from_step` get their LLM responses and
tool results from the recording, without calling the client or running the tool, and from
`from_step` on the run goes live with your overrides.

```python
with tracewright.replay(
    "4bf92f3577b34da6a3ce929d0e0e4736",
    from_step=3,
    overrides={"model": "claude-opus-5-5", "system_append": "Use plain numbers only."},
    tools="recorded",
) as r:
    agent.run(question)

print(r.trace_id, r.served_calls, r.live_calls, r.divergence)
```

`async with tracewright.replay(...)` works the same way for async agents. The recording is
fetched once on entry from `GET /v1/runs/{trace_id}` with the API key from `init()` (or
`api_key=` / `endpoint=`), so the run must belong to that key's project. Wrap exactly one
run of your agent in the block.

### What is a step

A step is a span carrying an integer `agent.step` attribute, which is its number:

```python
with tracewright.span(f"step-{n}", attributes={"agent.step": n}): ...
```

Each LLM or tool call belongs to its innermost enclosing step. Steps must be numbered the
same way on every run of your agent (the loop iteration is the natural choice). To use a
different convention pass `step="my.attribute"`, or a function
`step=lambda name, attributes: ...` that returns the step number for a step span and
`None` for anything else.

Calls outside any step, and calls nested inside another call (an LLM call made from a
tool), are never matched against the recording: they always run live.

### Matching

Only calls are replayed: `llm` spans from `instrument_anthropic` / `instrument_openai`, and
`tool` spans from `@trace(kind="tool")`. Within each step, calls are numbered in the order
they start, and the k-th live call of step s is compared with the k-th recorded call of
step s. Their signatures must be equal:

| call | signature |
|---|---|
| llm | `("llm", provider)` |
| tool | `("tool", name, arguments)`, arguments compared as JSON |

For a matching call:

| | before `from_step` | from `from_step` on |
|---|---|---|
| llm | served from the recording | live, with overrides |
| tool | served from the recording | served if `tools="recorded"` (arguments are already known to match), otherwise live |

**Divergence.** The first mismatch, meaning a different signature, an extra call, or
leaving a step before making all of its recorded calls, marks the replay as diverged, and
`r.divergence` records where. After that the recording no longer describes what the live
run is doing, so every later call runs live (with overrides), even before `from_step`.
Replay never raises because the run took a different path. It also runs live a recorded
call whose output was truncated, and a `@trace(capture_output=False)` tool, because
neither has an output that could be served.

### Overrides

`overrides` is a dict (or `tracewright.Overrides`) applied to every LLM request that runs
live:

| key | effect |
|---|---|
| `model` | replaces `model` |
| `system` | replaces the system prompt (Anthropic `system=`; OpenAI's first `system`/`developer` message, inserted if missing) |
| `system_append` | appends text to the system prompt (after `system`, if both are given); with content blocks, adds a text block |
| `temperature` | replaces `temperature` |
| anything else | passed through as a request keyword argument, e.g. `{"max_tokens": 2000}` |

### What the replay records

The replay is a **new trace**. Its root span carries `tracewright.replay_of`,
`tracewright.replay_from_step`, `tracewright.replay_tools`, and
`tracewright.replay_overrides`; values under secret-looking keys (`api_key`,
`Authorization`, ...) and strings that look like credentials are replaced with
`"[redacted]"`. Served spans carry `tracewright.replayed: true` and
`tracewright.replay_source_span_id`, keep the recorded token counts so the two runs diff
cleanly, and have `tracewright.cost_usd: 0`. Step spans are marked `tracewright.replayed`
when every call in them was served.

A served LLM call returns a real SDK object (`anthropic.types.Message`,
`openai.types.chat.ChatCompletion`) rebuilt from the recording. A served tool call
returns the recorded output as JSON (dicts, lists, numbers, strings), so tools that
return custom objects get their JSON form back. A recorded exception is raised again as
a `tracewright.ReplayedError` subclass with the original type's name, so
`f"{type(exc).__name__}: {exc}"` reads the same as in the original run (an `except` for
the original class won't catch it).

### Limits

- Calls are matched by start order within a step, so tool calls that run concurrently on
  threads can start in a different order and cause a divergence. Concurrent asyncio tasks
  start in creation order and are fine.
- Streaming LLM calls are neither recorded nor replayed.
- Replay serves calls, not arbitrary code: anything your agent does outside instrumented
  LLM clients and `@trace(kind="tool")` functions (reading the clock, an uninstrumented
  HTTP call) runs live.

## Development

```sh
uv sync
uv run ruff check . && uv run mypy --strict src && uv run pytest
```
