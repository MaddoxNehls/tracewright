/**
 * Row -> domain mappers. The `postgres` driver returns int8 and numeric as
 * strings (to avoid silent precision loss) and timestamptz as Date; the UI
 * wants plain numbers and ISO strings, which are safe at these magnitudes.
 */
import type { JsonValue, Project, RunStatus, RunSummary, Span, SpanError, SpanKind } from "@/lib/types";

type Numeric = string | number | null;

export const num = (v: Numeric): number => (v == null ? 0 : Number(v));
export const numOrNull = (v: Numeric): number | null => (v == null ? null : Number(v));
export const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  isPublic: r.is_public,
});

export interface RunRow {
  trace_id: string;
  name: string;
  status: RunStatus;
  start_time: Date;
  end_time: Date;
  duration_ms: number;
  span_count: number;
  llm_call_count: number;
  tool_call_count: number;
  total_input_tokens: Numeric;
  total_output_tokens: Numeric;
  total_cost_usd: Numeric;
  tags: string[] | null;
  models: string[] | null;
}

export const toRunSummary = (r: RunRow): RunSummary => ({
  traceId: r.trace_id,
  name: r.name,
  status: r.status,
  startTime: iso(r.start_time),
  endTime: iso(r.end_time),
  durationMs: num(r.duration_ms),
  spanCount: num(r.span_count),
  llmCallCount: num(r.llm_call_count),
  toolCallCount: num(r.tool_call_count),
  inputTokens: num(r.total_input_tokens),
  outputTokens: num(r.total_output_tokens),
  costUsd: numOrNull(r.total_cost_usd),
  tags: r.tags ?? [],
  models: r.models ?? [],
});

export interface SpanRow {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_time: Date;
  end_time: Date;
  duration_ms: number;
  status: RunStatus;
  error: SpanError | null;
  attributes: Record<string, JsonValue> | null;
  input: JsonValue;
  output: JsonValue;
  model: string | null;
  input_tokens: Numeric;
  output_tokens: Numeric;
  cost_usd: Numeric;
}

export const toSpan = (r: SpanRow): Span => ({
  spanId: r.span_id,
  parentSpanId: r.parent_span_id,
  name: r.name,
  kind: r.kind,
  startTime: iso(r.start_time),
  endTime: iso(r.end_time),
  durationMs: num(r.duration_ms),
  status: r.status,
  error: r.error,
  attributes: r.attributes ?? {},
  input: r.input ?? null,
  output: r.output ?? null,
  model: r.model,
  inputTokens: numOrNull(r.input_tokens),
  outputTokens: numOrNull(r.output_tokens),
  costUsd: numOrNull(r.cost_usd),
});
