# Tracewright: Spec (v1)

> A flight recorder for AI agents.

## Problem
AI agents are nondeterministic, multi-step programs. When a prompt tweak or a model swap breaks something, teams find out from users, and they can't see *which step* diverged or *why*. Logs show text. They don't show the shape of a run.

## What it does
Records every step of an agent run, then lets you **inspect**, **diff**, **replay**, and **regression-test** runs.

## Architecture
```
 agent code
   └─ SDK (Python / TS) ──batched HTTP──▶ Ingest service (Go) ──▶ Postgres
                                                                   ▲
                       Dashboard (Next.js) ── reads ───────────────┘
                       CLI / GitHub Action ── regression checks
```

## Components

### 1. Span model
- Each run is a tree of spans: `run → step → {llm_call | tool_call | custom}`
- Each span records: ids, parent, name, kind, start/end, status/error, attributes (JSONB), input/output payloads
- LLM spans also record: model, messages, response, input/output tokens, cost (USD), latency
- Field names follow the **OpenTelemetry GenAI semantic conventions**, so traces stay interoperable with existing observability tools

### 2. SDKs (Python + TypeScript)
- `@trace` decorator or `trace()` wrapper for functions and tools
- Auto-instruments the Anthropic client: wrap it once and every call is recorded
- Exports in non-blocking background batches; never crashes the host agent; drops spans with a counter when the buffer is full

### 3. Ingest service (Go)
- `POST /v1/spans` (batched, API-key auth, schema validation)
- Buffered channel feeding batched `COPY` inserts, with backpressure (429)
- **Target metric:** sustained throughput and p99 latency, measured with a load test and published in the README

### 4. Dashboard (Next.js)
- Run list: filter by status, model, cost, latency, and tag
- Run detail: timeline waterfall plus a collapsible span tree; the span inspector shows the full prompt and response
- Aggregates: cost and latency over time, by model

### 5. Run diff (the interesting algorithm)
- Align two runs' span trees using sequence alignment over step signatures (kind + name + tool)
- Highlight the **first divergence point**, plus per-step deltas in cost, tokens, and latency, and a text diff of outputs

### 6. Replay
- `replay(run_id, from_step=N, overrides={model, prompt})`
- The SDK serves *recorded* tool results and LLM responses up to step N, then goes live with the overrides
- Answers "would the new prompt have fixed this run?" without re-running side effects

### 7. Regression check (CLI + GitHub Action)
- Run a suite of agent tasks and compare against a baseline run set
- Fail CI on score drops or on cost/latency over thresholds; post a summary table to the PR

### Demo agent
- A small research agent (web search + calculator + notes tools) generates realistic traces for the demo and tests

## Non-goals (v1)
- Multi-tenant orgs, billing, SSO
- Non-Anthropic auto-instrumentation (manual spans still work for any provider)
- Horizontal scaling of ingest; single-instance throughput only

## Stack and hosting
- Go 1.23+ ingest, Postgres on **Neon**, Next.js on **Vercel**, Go service on **Fly.io**
- Tests: Go unit + integration (testcontainers Postgres), SDK unit tests, Playwright e2e for the dashboard
- CI: GitHub Actions

## Milestones
1. Span model, schema, ingest service, Python SDK (end-to-end: a demo run lands in Postgres)
2. Dashboard: run list and run detail with waterfall
3. TypeScript SDK and Anthropic auto-instrumentation in both SDKs
4. Run diff
5. Replay
6. Regression CLI and GitHub Action
7. Load test, deploy, README with metrics, write-up

## Decisions
- **Name:** Tracewright. It's distinctive, searchable, and says what it does.
- **Auth:** GitHub OAuth (Auth.js) for real projects, plus a **public read-only demo project** seeded with real traces, so recruiters can explore without signing in.
- **LLM providers:** SDK auto-instruments both the Anthropic client and OpenAI-compatible clients (covers OpenRouter). The demo agent picks its backend through config: Anthropic API, OpenRouter, or `claude -p` locally (dev only; uses the subscription, never in hosted code).
- **Hosted demo makes no live LLM calls.** It serves recorded traces, so it costs $0 to keep running.
