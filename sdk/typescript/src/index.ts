/**
 * Tracewright: a flight recorder for AI agents.
 *
 * @example
 * import { init, instrumentAnthropic, run, trace } from "tracewright";
 *
 * init(); // reads TRACEWRIGHT_API_KEY / TRACEWRIGHT_ENDPOINT
 * const client = instrumentAnthropic(new Anthropic());
 * const search = trace(async (query: string) => searchWeb(query), { kind: "tool", name: "search" });
 *
 * const answer = await run("research", async () => { ... }, { tags: ["demo"], input: question });
 */

export {
  DEFAULT_ENDPOINT,
  type Exporter,
  type ExporterStats,
  HttpExporter,
  type HttpExporterOptions,
  NoopExporter,
} from "./exporter.ts";
export { type AnthropicClientLike, instrumentAnthropic } from "./instrumentation/anthropic.ts";
export { type InstrumentOpenAIOptions, instrumentOpenAI, type OpenAIClientLike } from "./instrumentation/openai.ts";
export type { JsonValue } from "./serialize.ts";
export { MAX_PAYLOAD_BYTES } from "./serialize.ts";
export { Span, type SpanError, type SpanKind, type SpanRecord, type SpanStatus } from "./span.ts";
export {
  flush,
  getCurrentSpan,
  type InitOptions,
  init,
  type RunOptions,
  run,
  type SpanOptions,
  shutdown,
  span,
  stats,
  type TraceOptions,
  trace,
} from "./tracer.ts";

export const VERSION = "0.1.0";
