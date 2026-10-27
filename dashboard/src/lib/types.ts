/**
 * Domain types shared by the server query layer and the UI.
 * They mirror docs/contract.md; numeric DB columns are normalized to `number`.
 */

export type SpanKind = "agent" | "llm" | "tool" | "custom";
export type RunStatus = "ok" | "error";

export const SPAN_KINDS: readonly SpanKind[] = ["agent", "llm", "tool", "custom"];
export const RUN_STATUSES: readonly RunStatus[] = ["ok", "error"];

export interface Project {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
}

export interface RunSummary {
  traceId: string;
  name: string;
  status: RunStatus;
  startTime: string; // ISO 8601
  endTime: string;
  durationMs: number;
  spanCount: number;
  llmCallCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  tags: string[];
  models: string[];
}

export interface SpanError {
  type: string;
  message: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Span {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: RunStatus;
  error: SpanError | null;
  attributes: Record<string, JsonValue>;
  input: JsonValue;
  output: JsonValue;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface RunDetail {
  run: RunSummary;
  spans: Span[];
}
