/** The span model: one timed step of an agent run, serialized per docs/contract.md. */

import { randomBytes } from "node:crypto";
import { type JsonValue, toJsonable, truncatePayload } from "./serialize.ts";

export type SpanKind = "agent" | "llm" | "tool" | "custom";
export type SpanStatus = "ok" | "error";

export interface SpanError {
  type: string;
  message: string;
}

/** A span in wire format: the JSON object `POST /v1/spans` accepts. */
export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_time: string;
  end_time: string;
  status: SpanStatus;
  error: SpanError | null;
  attributes: Record<string, JsonValue>;
  input: JsonValue;
  output: JsonValue;
}

export const MAX_NAME_LENGTH = 256;

// Anchor the wall clock once, then advance it with the monotonic high-resolution clock.
// Date.now() only has millisecond resolution, which would give sibling spans identical
// timestamps; hrtime keeps them correctly ordered.
const WALL_CLOCK_ANCHOR_NS = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

export function nowNs(): bigint {
  return WALL_CLOCK_ANCHOR_NS + process.hrtime.bigint();
}

/** Format nanoseconds since the Unix epoch as an RFC3339Nano UTC timestamp. */
export function formatTimestamp(unixNs: bigint): string {
  const ms = unixNs / 1_000_000n;
  const nanos = unixNs % 1_000_000_000n;
  const seconds = new Date(Number(ms)).toISOString().slice(0, 19);
  return `${seconds}.${nanos.toString().padStart(9, "0")}Z`;
}

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

export interface SpanInit {
  name: string;
  kind: SpanKind;
  traceId: string;
  parentSpanId: string | null;
  onEnd: (span: Span) => void;
}

/**
 * A single recorded operation.
 *
 * Spans are created through `run`, `span`, `trace` or an instrumented client rather than
 * constructed directly. Values passed to the setters are snapshotted immediately, so
 * mutating them afterwards has no effect. Every setter is a no-op once the span has ended.
 */
export class Span {
  readonly traceId: string;
  readonly spanId: string = newSpanId();
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: SpanKind;

  #attributes: Record<string, JsonValue> = {};
  #input: JsonValue = null;
  #output: JsonValue = null;
  #hasOutput = false;
  #status: SpanStatus = "ok";
  #error: SpanError | null = null;
  #ended = false;
  readonly #startNs = nowNs();
  #endNs: bigint | undefined;
  readonly #onEnd: (span: Span) => void;

  constructor(init: SpanInit) {
    // Ingest counts the limit in code points; slicing UTF-16 units could split a surrogate pair.
    this.name = Array.from(init.name || "span")
      .slice(0, MAX_NAME_LENGTH)
      .join("");
    this.kind = init.kind;
    this.traceId = init.traceId;
    this.parentSpanId = init.parentSpanId;
    this.#onEnd = init.onEnd;
  }

  get status(): SpanStatus {
    return this.#status;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Whether an output has been set explicitly; `run`/`span` won't overwrite it. */
  get hasOutput(): boolean {
    return this.#hasOutput;
  }

  get attributes(): Readonly<Record<string, JsonValue>> {
    return { ...this.#attributes };
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.#ended) this.#attributes[key] = toJsonable(value);
    return this;
  }

  setAttributes(attributes: Readonly<Record<string, unknown>>): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  setInput(value: unknown): this {
    if (!this.#ended) this.#input = toJsonable(value);
    return this;
  }

  setOutput(value: unknown): this {
    if (!this.#ended) {
      this.#output = toJsonable(value);
      this.#hasOutput = true;
    }
    return this;
  }

  setError(type: string, message: string): this {
    if (!this.#ended) {
      this.#status = "error";
      this.#error = { type, message };
    }
    return this;
  }

  recordException(error: unknown): this {
    if (error instanceof Error) return this.setError(error.name || "Error", error.message);
    const message = toJsonable(error);
    return this.setError("UnknownError", typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Finish the span and hand it to the exporter. Subsequent calls are no-ops. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#endNs = nowNs();
    this.#onEnd(this);
  }

  /** Serialize to the wire format, truncating oversized input/output. */
  toJSON(): SpanRecord {
    const input = truncatePayload(this.#input);
    const output = truncatePayload(this.#output);
    const attributes = { ...this.#attributes };
    if (input.truncated || output.truncated) attributes["tracewright.truncated"] = true;
    return {
      trace_id: this.traceId,
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      start_time: formatTimestamp(this.#startNs),
      end_time: formatTimestamp(this.#endNs ?? nowNs()),
      status: this.#status,
      error: this.#error,
      attributes,
      input: input.value,
      output: output.value,
    };
  }
}
