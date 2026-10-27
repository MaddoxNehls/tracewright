# tracewright-ingest

The Go service that receives agent spans from the Tracewright SDKs and writes
them to Postgres. The wire format, validation rules, and storage schema are
defined in [`docs/contract.md`](../docs/contract.md).

## Run it

With Docker, from the repo root:

```sh
docker compose up -d --build
docker compose exec ingest /usr/local/bin/tracewright-ingest admin create-project --slug demo --name "Demo" --public
KEY=$(docker compose exec -T ingest /usr/local/bin/tracewright-ingest admin create-key --project demo)

curl -H "Authorization: Bearer $KEY" localhost:4318/v1/spans -d '{"spans": [ ... ]}'
```

(In Git Bash on Windows, prefix `docker compose exec` with `MSYS_NO_PATHCONV=1`.)

Without Docker for the service itself:

```sh
export DATABASE_URL=postgres://tracewright:tracewright@localhost:5442/tracewright?sslmode=disable
go run ./cmd/tracewright-ingest            # serve
go run ./cmd/tracewright-ingest admin create-project --slug demo --name Demo
go run ./cmd/tracewright-ingest admin create-key --project demo
```

Migrations are embedded and applied at startup (and by the admin commands), so
an empty database is all you need. `create-key` prints the key once on stdout;
only its SHA-256 hash and a short display prefix are stored.

## Configuration

| Variable          | Default     | Meaning |
|-------------------|-------------|---------|
| `DATABASE_URL`    | (required)  | Postgres connection string. pgxpool options such as `pool_max_conns` work here. |
| `PORT`            | `4318`      | HTTP listen port. |
| `QUEUE_CAPACITY`  | `50000`     | Max spans buffered between handlers and writers. Must be at least 1000 (one full request). |
| `QUEUE_MAX_BYTES` | `268435456` | Max payload bytes buffered (256 MiB). Must be at least 5 MiB (one full request). |
| `WRITERS`         | `4`         | Concurrent batch writer goroutines. |
| `BATCH_MAX_SPANS` | `1000`      | A writer flushes once its batch holds this many spans... |
| `BATCH_MAX_WAIT`  | `200ms`     | ...or once this much time has passed since the batch's first span. |

## Endpoints

- `POST /v1/spans`: returns `202 {"accepted": n}`, `400` with indexed field errors, `401`, `413`, `415` (unknown `Content-Encoding`), or `429` with `Retry-After` when the queue is full.
- `GET /v1/runs/{trace_id}`: the run summary and all of its spans, ordered by start time, in the same span shape as `POST /v1/spans`. Same API keys; a key only sees its own project, and a run in another project is a `404`. Used by the SDKs' replay.
- `GET /healthz`: liveness check, returns `ok`.
- `GET /metrics`: Prometheus metrics, all prefixed `tracewright_`: `spans_received_total`, `spans_written_total`, `spans_rejected_total{reason}`, `write_failures_total`, `queue_depth`, `batch_write_duration_seconds`, `http_request_duration_seconds{route,method,code}`, plus Go runtime and process metrics.

## Layout

```
cmd/tracewright-ingest   main: wiring, graceful shutdown, admin subcommands
internal/api             HTTP handlers, request decoding and validation, API key auth + cache
internal/pipeline        bounded queue and batch writers
internal/store           pgx: embedded migrations, COPY write path, runs aggregation, projects/keys
internal/pricing         embedded pricing.json and cost calculation
internal/apikey          key generation, format check, hashing
internal/config          environment variables
internal/metrics         Prometheus instruments
internal/pgtest          testcontainers Postgres for integration tests
internal/e2e             HTTP-to-Postgres end-to-end test
```

## Tests

```sh
go vet ./...
go test ./...
```

Integration tests (`internal/store`, `internal/e2e`) start a `postgres:17-alpine`
container with testcontainers-go and are skipped if Docker isn't available.

## Design notes

**Bounded queue and 429 instead of blocking.** The handler validates the
request, then makes a non-blocking attempt to enqueue it. When the queue is
full it returns 429 with `Retry-After` right away. The alternative, blocking
until there's room, ties up a goroutine and a connection per waiting client,
hides overload from the client, and turns a slow database into unbounded
memory growth and timeouts. Backpressure gives the SDK a clear signal (back
off and retry, or drop with a counter), and the queue's memory stays bounded.
Admission is all-or-nothing per request, so a client never has to work out
which of its spans got in. The queue keeps two budgets, one for spans and one
for bytes, because span count alone doesn't bound memory: one span can carry
megabytes of prompt.

**COPY through a temp table.** `COPY` is by far the fastest way to load rows
into Postgres, but it can't express `ON CONFLICT`, and idempotency is part of
the contract: SDKs retry freely. So each flush runs `COPY` into a staging table,
then `INSERT INTO spans SELECT ... ON CONFLICT DO NOTHING`. That keeps COPY's
throughput, dedupes on `(project_id, trace_id, span_id)`, and gives an exact
count of newly inserted rows. The staging table is created once per connection
(`CREATE TEMP TABLE IF NOT EXISTS ... ON COMMIT DELETE ROWS`), not per flush,
so steady-state ingest doesn't churn the system catalog.

**Recompute `runs` in the same transaction.** Spans arrive out of order and the
root often comes last, so `runs` is recomputed from all of a trace's stored
spans rather than adjusted incrementally. Doing it in the same transaction as
the insert means the two tables always agree: no reader ever sees spans without
their run or a run that counts spans that were rolled back, and a crash can't
leave them half-updated. Recomputing from scratch also makes retries harmless,
since running it twice gives the same answer. One subtlety: two writers flushing
spans of the *same* trace concurrently would each recompute from a snapshot that
misses the other's uncommitted spans, and whichever committed last would win with
stale totals. Each flush therefore takes a transaction-scoped advisory lock per
affected trace, acquired in sorted order so writers can't deadlock.
`TestConcurrentWritesToOneTrace` loses updates without that lock.

**Failure handling.** Writes retry with jittered exponential backoff. Errors
that can't succeed on retry (Postgres data-exception and constraint classes) are
not retried. If one of those hits a coalesced batch, the writer retries each
original request on its own, so one bad request can't take down the others it
was batched with. Batches that still fail are logged with their trace IDs and
counted in `write_failures_total`.

**Graceful shutdown.** On SIGINT/SIGTERM the HTTP server stops accepting
connections and finishes in-flight requests. Then the queue is closed and the
writers flush everything already accepted (a 202 is a promise). The pool closes
last. All of this runs under a 25 s deadline, which fits inside the usual 30 s
grace period orchestrators allow.

**Auth cache.** Keys are looked up by SHA-256 hash. A fast hash is fine here
because keys are 128-bit random values, not passwords. Results are cached in
memory: valid keys for 60 s, unknown keys for 5 s. Lookup errors are never
cached, and the cache size is capped so random-key spam can't grow it without
bound. A revoked key keeps working for up to 60 s.

**Cost.** If a span has no `tracewright.cost_usd`, its cost is computed at
ingest from `pricing.json`, using the response model (falling back to the
request model) and its token counts. An unknown model, or a span with no token
counts, gets a null cost rather than a misleading $0. `pricing.json` lists
first-party Anthropic API prices only. Bedrock and Vertex price differently and
aren't included.
