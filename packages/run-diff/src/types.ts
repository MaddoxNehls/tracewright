/** Span kinds from the wire contract (docs/contract.md). */
export type SpanKind = 'agent' | 'llm' | 'tool' | 'custom';

export interface SpanError {
  type: string;
  message: string;
}

/**
 * A span exactly as stored (snake_case, per the wire contract). The optional trailing fields
 * are the denormalized columns of the `spans` table. They are used when present, and the
 * values are otherwise derived from `attributes`. Postgres `numeric`/`bigint` may arrive as
 * strings, which is also accepted.
 */
export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_time: string;
  end_time: string;
  status: 'ok' | 'error';
  error: SpanError | null;
  attributes: Record<string, unknown> | null;
  input: unknown;
  output: unknown;
  model?: string | null;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  cost_usd?: number | string | null;
}

/** The identity of a step, used to decide which steps of two runs may be aligned. */
export interface StepSignature {
  kind: SpanKind;
  /** The span name, with the model id removed for llm spans ("chat claude-x" → "chat"). */
  label: string;
  /** `gen_ai.tool.name` for tool spans. */
  tool: string | null;
  /** Model family for llm spans ("claude-sonnet-4-5-20250929" → "claude-sonnet"). */
  family: string | null;
  /**
   * Hard part of the signature: kind + label + tool. Two steps can only be aligned to each
   * other when this is equal.
   */
  compatKey: string;
  /** Full signature: compatKey + model family, e.g. `llm:chat@claude-sonnet`. */
  key: string;
}

/** A node of the span tree built from one run. */
export interface SpanNode {
  span: Span;
  parent: SpanNode | null;
  children: SpanNode[];
  /** Depth in the tree; roots are 0. */
  depth: number;
  /** Position in the pre-order traversal of the run. */
  index: number;
  /** The span's parent was missing from the run, or it was part of a parent cycle. */
  orphan: boolean;
  /**
   * A synthetic node standing in for a parent span that was referenced but never recorded
   * (e.g. the root of a run still in flight). Its orphaned children hang below it.
   */
  placeholder: boolean;
  /** Start and end in nanoseconds since the epoch. */
  startNs: bigint;
  endNs: bigint;
}

export interface RunTree {
  /** Top-level nodes (true roots, cycle-broken spans and placeholders), ordered by start. */
  roots: SpanNode[];
  /** All nodes in pre-order (`nodes[i].index === i`), placeholders included. */
  nodes: SpanNode[];
  /** Number of real spans (placeholders excluded, duplicates collapsed). */
  spanCount: number;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

/** What the UI needs to render one side of a row. `span` is the original object. */
export interface SpanRef {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  signature: string;
  model: string | null;
  status: 'ok' | 'error';
  error: SpanError | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  tokens: TokenUsage;
  costUsd: number | null;
  orphan: boolean;
  placeholder: boolean;
  /** Pre-order index of this span within its own run. */
  index: number;
  span: Span;
}

export type ChangeField =
  | 'presence'
  | 'model'
  | 'status'
  | 'error'
  | 'input'
  | 'output'
  | 'tokens'
  | 'cost'
  | 'latency';

/**
 * - `behavior`: what the step did (model, status, error, input, output). Always significant.
 * - `metric`: how much it took (tokens, cost, latency). Significant only past the thresholds.
 * - `recording`: one side has a placeholder because the span was never recorded.
 */
export type ChangeCategory = 'behavior' | 'metric' | 'recording';

export interface FieldChange {
  field: ChangeField;
  category: ChangeCategory;
  left: unknown;
  right: unknown;
  /** right − left, for numeric fields. For tokens it is the total. */
  delta?: number;
  /** delta / |left|, when left is non-zero. */
  ratio?: number;
  significant: boolean;
}

export type RowStatus = 'same' | 'modified' | 'added' | 'removed';

export interface DiffRow {
  status: RowStatus;
  left?: SpanRef;
  right?: SpanRef;
  /** Depth in the merged tree (0 = top level). */
  depth: number;
  /** Index of the parent row, or null for top-level rows. */
  parentIndex: number | null;
  /** One past the index of this row's last descendant: rows[i+1 .. end) is its subtree. */
  end: number;
  /** Some descendant row is not `same`. Useful to highlight or expand collapsed subtrees. */
  descendantsChanged: boolean;
  /** All differences, including metric deltas under the thresholds (`significant: false`). */
  changes: FieldChange[];
  /** For a removed row: the added row with an identical subtree (the step moved). */
  movedTo?: number;
  /** For an added row: the removed row with an identical subtree. */
  movedFrom?: number;
}

export type DivergenceReason = 'added' | 'removed' | ChangeField;

export interface Divergence {
  rowIndex: number;
  /**
   * `enter`: the step was added/removed, or differs before it ran (model, input).
   * `exit`: it differs in what it produced (output, status, error, metrics). Children run
   * between a span's enter and exit, so a parent's output change is attributed to its
   * children when they diverge first.
   */
  phase: 'enter' | 'exit';
  reasons: DivergenceReason[];
}

export interface RunTotals {
  spans: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of known span costs; null when no span has a cost. */
  costUsd: number | null;
  /** Wall time: max(end) − min(start). */
  durationMs: number;
  /** `error` if a root span (parent_span_id null) errored, as in the `runs` table. */
  status: 'ok' | 'error';
  errorSpans: number;
}

export interface DiffSummary {
  left: RunTotals;
  right: RunTotals;
  /** right − left. `costUsd` is null if either side has no cost data. */
  delta: {
    spans: number;
    llmCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
    durationMs: number;
  };
  statusChanged: boolean;
  rows: Record<RowStatus, number>;
}

export interface AlignmentStats {
  /** `banded` if any sibling list exceeded `maxCells` and used the banded fallback. */
  mode: 'exact' | 'banded';
  /** DP cells evaluated across all sibling alignments. */
  cells: number;
  /** Sibling lists aligned with DP (lists that were identical take a fast path). */
  alignments: number;
}

export interface RunDiff {
  rows: DiffRow[];
  firstDivergence: Divergence | null;
  summary: DiffSummary;
  alignment: AlignmentStats;
}

/** A metric delta is significant when |Δ| ≥ abs AND |Δ| / |left| ≥ rel. */
export interface Threshold {
  abs: number;
  rel: number;
}

export interface DiffThresholds {
  latencyMs: Threshold;
  costUsd: Threshold;
  tokens: Threshold;
}

export interface DiffOptions {
  thresholds?: Partial<DiffThresholds>;
  /**
   * Largest DP table (n+1)·(m+1) aligned exactly for one sibling list; bigger lists use the
   * banded fallback. Default 1,000,000 (≈ 1000 × 1000 siblings, ~9 MB of scratch).
   */
  maxCells?: number;
  /** Half-width of the band, in cells, around the diagonal in banded mode. Default 100. */
  bandRadius?: number;
}
