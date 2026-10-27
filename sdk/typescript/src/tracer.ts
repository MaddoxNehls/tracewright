/** Global tracer state, async context propagation, and the `run` / `span` / `trace` wrappers. */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_ENDPOINT, type Exporter, type ExporterStats, HttpExporter, NoopExporter } from "./exporter.ts";
import { log } from "./log.ts";
import { newTraceId, Span, type SpanKind } from "./span.ts";

const EXIT_FLUSH_TIMEOUT_MS = 2000;

// The current span follows the logical call chain through awaits, timers and callbacks,
// so concurrent work (Promise.all, parallel tool calls) gets the right parent.
const storage = new AsyncLocalStorage<Span>();
let exporter: Exporter = new NoopExporter();
let exitHookInstalled = false;

export interface InitOptions {
  /** Defaults to `TRACEWRIGHT_API_KEY`. Without a key the SDK is a silent no-op. */
  apiKey?: string;
  /** Defaults to `TRACEWRIGHT_ENDPOINT`, then `http://localhost:4318`. */
  endpoint?: string;
  /** Use a custom exporter (e.g. `InMemoryExporter` in tests) instead of HTTP. */
  exporter?: Exporter;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

/**
 * Configure the SDK. Calling it again replaces (and flushes) the previous exporter.
 *
 * Unconfigured, the SDK is a silent no-op: spans are still created so instrumented code
 * runs unchanged, but nothing is sent.
 */
export function init(options: InitOptions = {}): void {
  const { apiKey, endpoint, exporter: custom, ...tuning } = options;
  const key = apiKey || process.env["TRACEWRIGHT_API_KEY"];
  const next =
    custom ??
    (key
      ? new HttpExporter({
          ...tuning,
          apiKey: key,
          endpoint: endpoint || process.env["TRACEWRIGHT_ENDPOINT"] || DEFAULT_ENDPOINT,
        })
      : new NoopExporter());

  const previous = exporter;
  exporter = next;
  installExitHook();
  void shutdownSafely(previous, EXIT_FLUSH_TIMEOUT_MS);
}

/** Wait for queued spans to be delivered. Resolves false on timeout; never rejects. */
export async function flush(timeoutMs = 5000): Promise<boolean> {
  try {
    return await exporter.flush(timeoutMs);
  } catch (error) {
    log.debug("flush failed", error);
    return false;
  }
}

/** Flush and stop the exporter, reverting to no-op mode. Never rejects. */
export async function shutdown(timeoutMs = 5000): Promise<void> {
  const previous = exporter;
  exporter = new NoopExporter();
  await shutdownSafely(previous, timeoutMs);
}

/** Counters from the active exporter. */
export function stats(): ExporterStats {
  return exporter.stats;
}

export function getCurrentSpan(): Span | undefined {
  return storage.getStore();
}

export interface SpanOptions {
  kind?: SpanKind;
  input?: unknown;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface RunOptions {
  tags?: readonly string[];
  input?: unknown;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface TraceOptions {
  kind?: SpanKind;
  /** Defaults to the function's name. */
  name?: string;
  /** Record the call's arguments (as an array) as the span input. Default true. */
  captureInput?: boolean;
  /** Record the return value as the span output. Default true. */
  captureOutput?: boolean;
}

/**
 * Start a new run: a root `agent` span with a fresh trace id, current for the duration
 * of `fn`. Returns what `fn` returns; a returned promise is awaited before the span ends.
 * The return value is recorded as the run's output unless `span.setOutput` was called.
 */
export function run<T>(name: string, fn: (span: Span) => Promise<T>, options?: RunOptions): Promise<T>;
export function run<T>(name: string, fn: (span: Span) => T, options?: RunOptions): T;
export function run<T>(name: string, fn: (span: Span) => T, options: RunOptions = {}): T {
  const attributes: Record<string, unknown> = { ...options.attributes };
  if (options.tags) attributes["tracewright.tags"] = options.tags.map(String);
  const root = startSpan(name, "agent", { input: options.input, attributes, newTrace: true });
  return withSpan(root, fn, true);
}

/** Run `fn` inside a child of the current span (or a new trace if there is none). */
export function span<T>(name: string, fn: (span: Span) => Promise<T>, options?: SpanOptions): Promise<T>;
export function span<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
export function span<T>(name: string, fn: (span: Span) => T, options: SpanOptions = {}): T {
  const child = startSpan(name, options.kind ?? "custom", options);
  return withSpan(child, fn, true);
}

/**
 * Wrap a sync or async function so each call is recorded as a span. The wrapper has the
 * same type as `fn`; `this` is passed through. Errors mark the span and are rethrown.
 *
 * @example
 * const search = trace(async (query: string) => searchWeb(query), { kind: "tool", name: "search" });
 */
export function trace<F extends (...args: never[]) => unknown>(fn: F, options: TraceOptions = {}): F {
  const { kind = "custom", captureInput = true, captureOutput = true } = options;
  const name = options.name ?? (fn.name || "anonymous");
  const attributes = kind === "tool" ? { "gen_ai.tool.name": name } : undefined;
  const target = fn as unknown as (this: unknown, ...args: unknown[]) => unknown;

  function traced(this: unknown, ...args: unknown[]): unknown {
    const current = startSpan(name, kind, { input: captureInput ? args : undefined, attributes });
    return withSpan(current, () => target.apply(this, args), captureOutput);
  }
  Object.defineProperty(traced, "name", { value: name });
  return traced as unknown as F;
}

interface StartOptions {
  input?: unknown;
  attributes?: Readonly<Record<string, unknown>> | undefined;
  newTrace?: boolean;
}

/** Create a span parented to the current one. Exported for the instrumentation modules. */
export function startSpan(name: string, kind: SpanKind, options: StartOptions = {}): Span {
  const parent = options.newTrace ? undefined : storage.getStore();
  const created = new Span({
    name,
    kind,
    traceId: parent?.traceId ?? newTraceId(),
    parentSpanId: parent?.spanId ?? null,
    onEnd: exportSafely,
  });
  if (options.input !== undefined) created.setInput(options.input);
  if (options.attributes) created.setAttributes(options.attributes);
  return created;
}

/** Make `current` the active span while `fn` runs, then end it when `fn` settles. */
function withSpan<T>(current: Span, fn: (span: Span) => T, captureOutput: boolean): T {
  const succeed = <V>(value: V): V => {
    if (captureOutput && value !== undefined && !current.hasOutput) current.setOutput(value);
    current.end();
    return value;
  };
  const fail = (error: unknown): never => {
    current.recordException(error);
    current.end();
    throw error;
  };

  let result: T;
  try {
    result = storage.run(current, fn, current);
  } catch (error) {
    return fail(error);
  }
  return isPromiseLike(result) ? (Promise.resolve(result).then(succeed, fail) as T) : succeed(result);
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function exportSafely(finished: Span): void {
  try {
    exporter.export(finished);
  } catch (error) {
    log.debug("export failed", error);
  }
}

async function shutdownSafely(target: Exporter, timeoutMs: number): Promise<void> {
  try {
    await target.shutdown(timeoutMs);
  } catch (error) {
    log.debug("exporter shutdown failed", error);
  }
}

// `beforeExit` fires when the event loop drains naturally (not on process.exit() or a
// signal); the flush it starts is bounded, and `once` stops it from re-arming forever.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("beforeExit", () => void flush(EXIT_FLUSH_TIMEOUT_MS));
}
