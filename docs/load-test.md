# Ingest load test

**Headline:** one ingest instance sustained **24,400 spans/s** (about 68 MB/s of span JSON)
into Postgres for 60 s. That was with no 429s, request latency p50 / p95 / p99 of
**6 / 17 / 25 ms**, and every span written to its table within **189 ms** (p99) of its
batch leaving the client. The ceiling on this machine was about 26k spans/s with gzip and
32k without, set by CPU in the Docker VM rather than by ingest.

These are single-box numbers: client, ingest and Postgres share one 4-CPU Docker Desktop
VM. Read them as a lower bound on what the design does, not as a capacity plan.

## Setup

| | |
|---|---|
| Machine | AMD Ryzen 7 7800X3D (8 cores / 16 threads), 31 GB RAM, Samsung 990 PRO NVMe, Windows 11 Pro |
| Docker | Docker Desktop 28.4 on WSL2. The VM has **4 CPUs and 5.8 GB**, shared by ingest, Postgres, the load generator, and about a dozen unrelated idle containers |
| Postgres | `postgres:17` from `docker-compose.yml`, default settings, data on a Docker volume |
| Ingest | `ingest/Dockerfile` image, run as a second container on the compose network so each experiment can change its environment |
| Load generator | [`ingest/cmd/loadgen`](../ingest/cmd/loadgen), a Linux build running in a container on the same network |

**Workload.** Research-agent-shaped traces of 31 spans: a root `agent` span, then 10
steps of {step span, LLM span, tool span}. Each LLM span carries a 4–8 KB prompt (made of
English-like words, so it compresses as real text does) plus a 300–800 byte completion,
and token counts that ingest prices. Each tool span carries a few hundred bytes, and 5% of
tool calls fail. Spans average about 2.8 KB of JSON. Requests carry 100 spans,
gzip-compressed as the SDKs send them.

**Method.** Each stage runs N closed-loop clients for a fixed time. Each client sends a
batch as soon as the previous one returns, and waits out `Retry-After` on a 429, as the
SDK exporters do. After a stage, loadgen waits for ingest's queue to drain, and diffs
`/metrics` before and after:

- **written/s**: `spans_written_total` delta divided by (send time + drain time). It counts
  only spans that reached Postgres.
- **latency**: client-side, request sent to response read.
- **flush ms**, **spans/flush**: from the `batch_write_duration_seconds` histogram.
- **max queue**: peak `queue_depth`, sampled every 250 ms.
- **write lag**: `spans.received_at − end_time`, where loadgen sets every span's
  `end_time` to the moment its batch was built. That covers client encode, HTTP, queueing,
  batching and the insert transaction. It is computed in SQL over every span of the stage,
  corrected for the client/database clock offset (measured with NTP-style min-RTT sampling;
sub-millisecond here).
  `received_at` is the insert transaction's start time, so the lag excludes the COPY and
  the commit themselves.

```sh
go run ./cmd/loadgen -url http://ingest:4318 -key "$KEY" \
    -database-url "postgres://tracewright:tracewright@postgres:5432/tracewright" \
    -concurrency 1,2,4,8,16,32 -duration 20s -json results.json
```

## Experiments

### 1. Defaults (4 writers, flush at 1,000 spans or 200 ms)

| clients | accepted/s | written/s | p50 ms | p95 ms | p99 ms | 429 % | flush ms | spans/flush | max queue | lag p50 | lag p99 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 13,715 | 13,310 | 2.6 | 5.1 | 8.3 | 0 | 67 | 946 | 200 | 103 | 211 |
| 2 | 19,729 | 19,154 | 3.3 | 9.2 | 13.4 | 0 | 80 | 992 | 300 | 60 | 184 |
| 4 | 23,382 | 22,703 | 6.7 | 18.1 | 26.3 | 0 | 120 | 998 | 1,200 | 39 | 119 |
| 8 | 24,028 | 22,894 | 10.8 | 34.9 | 55.7 | 0.5 | 170 | 999 | 50,000 | 1,359 | 1,860 |
| 16 | 24,931 | 22,897 | 15.3 | 61.7 | 94.2 | 2.2 | 172 | 1,000 | 49,900 | 1,497 | 2,224 |
| 32 | 24,503 | 22,507 | 23.0 | 137.1 | 229.6 | 5.0 | 173 | 999 | 50,000 | 1,385 | 2,292 |

Writes plateau at about 22.9k spans/s from 4 clients on. Beyond that the queue fills to
its 50,000-span cap and ingest sheds load with 429s, so latency grows only by the time
spent queued. It doesn't grow without bound, and a rejected request is the client's to
retry, so nothing accepted is lost (experiment 6 checks this exactly). The ceiling matches the writers: 4 writers × 1,000 spans
per 170 ms flush ≈ 23.5k/s. At low load, lag is dominated by the 200 ms `BATCH_MAX_WAIT`
(a writer holds a partial batch for up to that long). Once the queue is full, lag is
queueing time: about 50,000 spans ÷ 23k/s ≈ 2 s.

A `docker stats` sample midway through the ramp put the VM's CPU on Postgres (167%),
ingest (31%) and the load generator (17%), out of 400%.

### 2. Writers 4 → 8

| clients | written/s | p99 ms | 429 % | flush ms | lag p99 |
|---:|---:|---:|---:|---:|---:|
| 4 | 24,512 | 23.2 | 0 | 222 | 196 |
| 8 | **25,803** | 52.6 | 0 | 301 | 1,670 |
| 16 | 25,533 | 95.8 | 1.9 | 305 | 1,970 |
| 32 | 23,770 | 251.5 | 4.2 | 328 | 1,896 |

+13% at the knee, but each flush got slower (170 → 300 ms) as more writers competed for
Postgres. A mid-ramp sample had the VM nearly out of CPU: Postgres 176%, loadgen 104%,
ingest 50%.

### 3. Bigger flushes (4 writers, `BATCH_MAX_SPANS=2500`)

| clients | written/s | p99 ms | 429 % | flush ms | spans/flush |
|---:|---:|---:|---:|---:|---:|
| 8 | 24,167 | 46.2 | 0.6 | 398 | 2,489 |
| 16 | 23,202 | 105.6 | 1.9 | 420 | 2,500 |

No better than the default. Per-transaction overhead (staging-table COPY, the
`INSERT ... SELECT ... ON CONFLICT`, the advisory locks, the `runs` recompute) is already
amortized at 1,000 spans; the per-row cost of writing 2.8 KB of JSONB dominates.

### 4. Gzip off (8 writers)

| clients | written/s | p99 ms | 429 % | flush ms | lag p99 |
|---:|---:|---:|---:|---:|---:|
| 8 | **32,039** | 33.6 | 1.0 | 244 | 1,402 |
| 16 | 30,269 | 60.6 | 2.4 | 257 | 1,532 |

+24% over the same configuration with gzip. That confirms the box is CPU-bound: the CPU
saved on compression (in the client) and decompression (in ingest) went to Postgres, and
flushes sped up. In production the client's half of that cost runs on the agent's
machine, so this overstates the gain. The SDKs keep gzip on, because bandwidth to a
hosted ingest matters more than CPU there.

### 5. Writers 8 → 16

| clients | written/s | p99 ms | 429 % | flush ms | lag p99 |
|---:|---:|---:|---:|---:|---:|
| 8 | 25,439 | 54.6 | 0 | 536 | 447 |
| 16 | 25,932 | 108.4 | 1.2 | 595 | 1,833 |

Same plateau, with flushes twice as slow: past 8 writers, extra concurrency only adds
contention. The pool needs no separate tuning, since ingest sizes it to writers + 4 (one
connection per writer for a whole flush, plus headroom for auth lookups), and pool waits
never showed up.

### 6. Sustained: 8 writers, 4 clients, 60 s

| clients | accepted/s | written/s | p50 ms | p95 ms | p99 ms | 429 % | flush ms | spans/flush | max queue | lag p50 | lag p95 | lag p99 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 24,612 | **24,368** | 6.0 | 16.8 | 25.2 | **0** | 242 | 996 | 3,000 | 50 | 138 | **189** |

`/metrics` after the run (the container started fresh, so these are the run's totals):

```
tracewright_spans_received_total 1.4771e+06
tracewright_spans_written_total 1.4771e+06
tracewright_spans_rejected_total{reason="invalid"} 0
tracewright_spans_rejected_total{reason="queue_full"} 0
tracewright_write_failures_total 0
tracewright_queue_depth 0
tracewright_batch_write_duration_seconds_sum 359.43    # 1,483 flushes, 242 ms mean
tracewright_batch_write_duration_seconds_count 1483
tracewright_http_request_duration_seconds_sum{code="202",route="POST /v1/spans"} 66.24
tracewright_http_request_duration_seconds_count{code="202",route="POST /v1/spans"} 14771
```

Inside ingest, a 202 took 4.5 ms on average (validate, price, enqueue). The rest of the
client's 6 ms is network and gzip.

## Recommended settings

`WRITERS=8`, with the other defaults (`BATCH_MAX_SPANS=1000`, `BATCH_MAX_WAIT=200ms`,
`QUEUE_CAPACITY=50000`). The defaults in code stay at 4 writers, because a small hosted
Postgres (a Neon free tier, say) has few connections and little CPU to spare. For the
deploy, scale writers with the database, not with ingest.

## Caveats

- **One box.** The client, ingest and Postgres share 4 vCPUs, so the client's CPU
  (compression especially) comes straight out of the database's budget. With Postgres on
  its own machine, as in the deployed setup, write throughput would be higher. A managed
  Postgres over a network adds round-trip time to each flush instead.
- **Docker Desktop's port proxy.** Running the same client from Windows through the
  published port adds about 40 ms to every request, whatever its size: p50 was 44.9 ms for
  one client against 2.6 ms inside the Docker network, and one client managed 2k spans/s
  instead of 13k. That's why loadgen runs inside the network here. Production clients
  don't pass through this proxy.
- **Default Postgres settings.** `shared_buffers`, WAL, checkpoint and autovacuum tuning
  were left alone. One host-side run saw a burst of 429s with multi-second lag, consistent
  with a checkpoint or autovacuum pass on the growing table; it didn't recur in the runs
  above.
- **Fresh data.** Each experiment appended to the same tables (about 11M spans, 17 GB by
  the end). The test project was deleted afterwards.
- **Short stages.** 20 s stages find the knee; only experiment 6 ran for a minute.
