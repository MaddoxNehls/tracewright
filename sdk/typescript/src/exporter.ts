/** Span exporters. The HTTP exporter ships gzipped batches without ever blocking the host. */

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { log } from "./log.ts";
import type { Span } from "./span.ts";

const gzipAsync = promisify(gzip);

export const DEFAULT_ENDPOINT = "http://localhost:4318";
const SPANS_PATH = "/v1/spans";
// The contract allows 5 MB per request; stay well under it before compression.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ExporterStats {
  /** Spans the ingest service accepted. */
  exported: number;
  /** Spans discarded because the in-memory buffer was full. */
  droppedQueueFull: number;
  /** Spans given up on: rejected by ingest, out of retries, or unserializable. */
  failed: number;
}

/** Receives finished spans. Implementations must never throw into the caller. */
export interface Exporter {
  export(span: Span): void;
  /** Resolve once queued spans are delivered: true on success, false on timeout. */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flush, then stop accepting spans. */
  shutdown(timeoutMs?: number): Promise<void>;
  readonly stats: ExporterStats;
}

export class NoopExporter implements Exporter {
  export(): void {}
  flush(): Promise<boolean> {
    return Promise.resolve(true);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  get stats(): ExporterStats {
    return { exported: 0, droppedQueueFull: 0, failed: 0 };
  }
}

export interface HttpExporterOptions {
  apiKey: string;
  endpoint?: string;
  /** Spans per request. */
  batchSize?: number;
  /** How long a partial batch may wait before it is sent. */
  flushIntervalMs?: number;
  /** Buffer capacity; spans beyond it are dropped and counted. */
  maxQueueSize?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to an unref'd setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Batches spans to `POST /v1/spans`.
 *
 * `export` is an O(1) push onto a bounded buffer; when the buffer is full the span is
 * dropped and counted. A batch is sent once `batchSize` spans are waiting or the oldest has
 * waited `flushIntervalMs`. Network errors, 429 and 5xx are retried with exponential
 * backoff and full jitter, honouring `Retry-After`; other 4xx are permanent (ingest is
 * idempotent, so retrying a batch that partially landed is safe). Every timer is unref'd,
 * so a pending export never keeps the process alive on its own.
 */
export class HttpExporter implements Exporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #maxQueueSize: number;
  readonly #maxRetries: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  #queue: Span[] = [];
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<void> | undefined;
  #closed = false;
  readonly #stats: ExporterStats = { exported: 0, droppedQueueFull: 0, failed: 0 };

  constructor(options: HttpExporterOptions) {
    this.#url = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "") + SPANS_PATH;
    this.#headers = {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    };
    this.#batchSize = options.batchSize ?? 100;
    this.#flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.#maxQueueSize = options.maxQueueSize ?? 2048;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#backoffBaseMs = options.backoffBaseMs ?? 500;
    this.#backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? unrefSleep;
  }

  get stats(): ExporterStats {
    return { ...this.#stats };
  }

  export(span: Span): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#stats.droppedQueueFull++;
      return;
    }
    this.#queue.push(span);
    if (this.#queue.length >= this.#batchSize) {
      this.#clearTimer();
      // Defer so the host's synchronous code never pays for serialization.
      queueMicrotask(() => void this.#drain());
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.#drain();
      }, this.#flushIntervalMs).unref();
    }
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    this.#clearTimer();
    // This one timer is deliberately ref'd: a caller awaiting flush() expects the process
    // to stay up until delivery finishes or the deadline passes.
    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = this.#drain().then(() => this.#queue.length === 0);
    try {
      return await Promise.race([drained, timedOut]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.#closed) return;
    await this.flush(timeoutMs);
    this.#closed = true;
    this.#clearTimer();
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Send everything queued. Concurrent callers share the one in-flight drain. */
  #drain(): Promise<void> {
    this.#draining ??= this.#drainLoop().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drainLoop(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#batchSize);
      try {
        await this.#exportBatch(batch);
      } catch (error) {
        // Defensive: #exportBatch handles its own failures, but the loop must survive anything.
        log.warn("unexpected export failure", error);
        this.#stats.failed += batch.length;
      }
    }
  }

  async #exportBatch(batch: Span[]): Promise<void> {
    let chunk: string[] = [];
    let chunkBytes = 0;
    for (const span of batch) {
      let encoded: string;
      try {
        encoded = JSON.stringify(span.toJSON());
      } catch (error) {
        log.warn(`dropping unserializable span "${span.name}"`, error);
        this.#stats.failed++;
        continue;
      }
      const bytes = Buffer.byteLength(encoded) + 1;
      if (chunk.length > 0 && chunkBytes + bytes > MAX_BODY_BYTES) {
        await this.#send(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(encoded);
      chunkBytes += bytes;
    }
    if (chunk.length > 0) await this.#send(chunk);
  }

  async #send(encodedSpans: string[]): Promise<void> {
    const count = encodedSpans.length;
    const body = await gzipAsync(`{"spans":[${encodedSpans.join(",")}]}`);

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      let delayMs: number;
      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers: this.#headers,
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        if (response.ok) {
          this.#stats.exported += count;
          return;
        }
        if (!isRetryable(response.status)) {
          const detail = await response.text().catch(() => "");
          log.warn(`ingest rejected ${count} spans with HTTP ${response.status}: ${detail.slice(0, 500)}`);
          break;
        }
        delayMs = parseRetryAfter(response.headers.get("retry-after"), this.#backoffMaxMs) ?? this.#backoff(attempt);
      } catch (error) {
        // fetch rejects on network failure or timeout; both are worth retrying.
        log.debug(`export attempt ${attempt + 1} failed`, error);
        delayMs = this.#backoff(attempt);
      }
      if (attempt === this.#maxRetries) {
        log.warn(`giving up on ${count} spans after ${attempt + 1} attempts`);
        break;
      }
      await this.#sleep(delayMs);
    }
    this.#stats.failed += count;
  }

  /** Full jitter: uniform in [0, min(max, base * 2^attempt)]. */
  #backoff(attempt: number): number {
    return Math.random() * Math.min(this.#backoffMaxMs, this.#backoffBaseMs * 2 ** attempt);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds, capped at `capMs`. */
export function parseRetryAfter(header: string | null, capMs: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(ms, 0), capMs);
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
