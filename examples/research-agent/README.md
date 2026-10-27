# research-agent

A small tool-using research agent that generates realistic [Tracewright](../../docs/spec.md)
traces. Given a question, it loops (the model picks a tool, the tool runs, the result goes back)
until the model answers.

**Tools**

| tool | what it does |
|---|---|
| `search_corpus` | BM25 search over 25 bundled articles on the history of spaceflight (`src/research_agent/corpus/`) |
| `calculator` | arithmetic by walking the Python AST (no `eval`; numbers and `+ - * / // % **` only) |
| `save_note` | keeps a note in memory, and writes it to `--notes-dir` if given |

**Backends** (`--backend`)

| backend | how | needs |
|---|---|---|
| `mock` (default) | scripted, deterministic turns; see `--list-scenarios` | nothing |
| `anthropic` | Anthropic SDK with native tool use, auto-instrumented | `ANTHROPIC_API_KEY` |
| `openrouter` | OpenAI SDK pointed at `https://openrouter.ai/api/v1`, auto-instrumented | `OPENROUTER_API_KEY` |
| `claude-cli` | shells out to `claude -p --output-format json`, tools via a JSON protocol in the prompt; recorded as a manual `llm` span | a logged-in `claude` CLI (local dev only) |

## Run

```bash
cd examples/research-agent
uv sync

# Offline, no keys: print the span tree locally
uv run research-agent --backend mock --print-spans
uv run research-agent --scenario calculator-recovery --print-spans
uv run research-agent --list-scenarios

# Send traces to a running ingest service (see docker-compose.yml at the repo root)
export TRACEWRIGHT_API_KEY=tw_...            # endpoint defaults to http://localhost:4318
uv run research-agent --scenario apollo-gap

# Real models
uv run research-agent "Who was the first woman in space?" --backend anthropic
uv run research-agent "When did Voyager 1 reach interstellar space?" --backend openrouter
```

Without `TRACEWRIGHT_API_KEY`, the SDK is a silent no-op and the agent runs unchanged.

### Mock scenarios

- `apollo-gap`: two searches, a calculation and a saved note, then an answer (5 steps).
- `calculator-recovery`: the calculator rejects `21.5 kg / 382 kg * 100`; the error goes back
  to the model, which retries with plain numbers and recovers (an error span inside an `ok` run).
- `parallel-lookup`: two searches issued in one step, then a calculation.

The mock answers its scenario's script whatever question you pass. Its final answer is
templated from the real tool outputs, so traces stay internally consistent. Use
`--mock-latency` (default 0.3 s) to give the LLM spans realistic durations.

## Trace shape

```
agent  research-agent
  custom step-1
    llm    chat mock-1
    tool   search_corpus
  custom step-2
    llm    chat mock-1
    tool   calculator          <- status=error, recovered in the next step
  ...
```

The root span carries `tracewright.tags` (`research-agent`, `backend:<name>`,
`scenario:<name>`), the question as input and the answer as output. LLM spans follow the
OpenTelemetry GenAI conventions in [`docs/contract.md`](../../docs/contract.md).

## Test

```bash
uv run pytest        # offline; real-provider backends run against fake clients
uv run ruff check . && uv run mypy
```
