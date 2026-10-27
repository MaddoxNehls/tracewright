# Tracewright Wire Contract (v1)

The SDKs and the ingest service both build against this file. Change it here first.

## Repo layout
```
ingest/              Go module github.com/MaddoxNehls/tracewright/ingest
sdk/python/          Python package `tracewright` (uv project)
examples/research-agent/   demo agent that uses the Python SDK
docker-compose.yml   postgres:17 + ingest
docs/
```

## Endpoint
`POST /v1/spans`
- Header `Authorization: Bearer <api_key>`. Keys look like `tw_<32 hex>`.
- Body `{"spans": [Span, ...]}`, 1–1000 spans, max 5 MB (gzip `Content-Encoding` accepted)
- Responses:
  - `202 {"accepted": n}`: queued for write
  - `400 {"error": "...", "details": [{"index": i, "field": "...", "message": "..."}]}`: validation failure; the whole batch is rejected
  - `401`: missing or invalid key
  - `413`: too large
  - `429` + `Retry-After: <seconds>`: queue full (backpressure)
- Ingest is **idempotent**: re-sending a span with the same `(trace_id, span_id)` is a no-op. SDKs retry freely.

`GET /healthz` returns 200 `ok`. `GET /metrics` serves Prometheus text.

## Span (JSON)
| field | type | notes |
|---|---|---|
| `trace_id` | string, 32 lowercase hex | one trace = one **run** |
| `span_id` | string, 16 lowercase hex | |
| `parent_span_id` | string or null | null means the root span of the run |
| `name` | string, 1–256 chars | |
| `kind` | `"agent"` \| `"llm"` \| `"tool"` \| `"custom"` | the root span should be `agent` |
| `start_time` | RFC3339Nano UTC string | |
| `end_time` | RFC3339Nano UTC string | ≥ start_time |
| `status` | `"ok"` \| `"error"` | |
| `error` | `{"type": str, "message": str}` or null | required when status=error |
| `attributes` | object (string keys, JSON values) | see below |
| `input` | any JSON or null | SDK truncates >256 KB |
| `output` | any JSON or null | SDK truncates >256 KB |

### Attribute keys (OpenTelemetry GenAI semantic conventions)
- `gen_ai.provider.name`: `"anthropic"`, `"openai"`, `"openrouter"`, `"claude-cli"`, …
- `gen_ai.operation.name`: `"chat"`
- `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (ints)
- `gen_ai.response.finish_reasons` (string array)
- `gen_ai.tool.name` (tool spans)
- `tracewright.tags`: string array, read from the root span only
- `tracewright.cost_usd`: optional number. If absent, ingest computes it from `pricing.json` using response/request model + tokens; unknown model means null cost.
- `tracewright.truncated`: true if the SDK truncated input or output

## Storage (Postgres)
- `projects(id uuid pk, slug text unique, name text, is_public bool, created_at)`
- `api_keys(id uuid pk, project_id fk, prefix text, key_hash bytea unique /* sha256 */, created_at, revoked_at null)`
- `spans`: pk `(project_id, trace_id, span_id)`; all span fields, plus denormalized `model`, `input_tokens`, `output_tokens`, `cost_usd numeric(12,6)`, `duration_ms` (generated), `received_at`. Index `(project_id, trace_id)`.
- `runs`: pk `(project_id, trace_id)`; `name`, `status`, `start_time`, `end_time`, `duration_ms`, `span_count`, `llm_call_count`, `tool_call_count`, `total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `tags text[]`, `models text[]`, `updated_at`. Index `(project_id, start_time desc)`.
  - Recomputed by ingest after each write for the affected traces (spans arrive out of order; the root may come last). Name and tags come from the root span; before the root arrives, the name is the earliest span's name. Status is `error` if the root errored, else `ok`. Timing is min(start) to max(end).
