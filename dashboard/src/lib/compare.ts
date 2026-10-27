/**
 * Glue between the dashboard's span model and @tracewright/run-diff, plus the
 * replay rules the dashboard layers on top of the generic diff.
 */
import { diffRuns, findFirstDivergence, type DiffRow, type RunDiff, type Span as WireSpan } from "@tracewright/run-diff";
import { isReplayed, replayInfo } from "./replay";
import type { Span } from "./types";

export { isReplayed, replayInfo, type ReplayInfo } from "./replay";

/** Converts a stored span back to its wire-contract shape, which is what run-diff consumes. */
export function toWireSpan(traceId: string, s: Span): WireSpan {
  return {
    trace_id: traceId,
    span_id: s.spanId,
    parent_span_id: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    start_time: s.startTime,
    end_time: s.endTime,
    status: s.status,
    error: s.error,
    attributes: s.attributes,
    input: s.input,
    output: s.output,
    model: s.model,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    cost_usd: s.costUsd,
  };
}

const TIMING_FIELDS = new Set(["cost", "latency"]);

/**
 * A replayed step's cost and latency describe serving the recording (zero spend,
 * about a millisecond), not the agent's behavior. On rows where either side was
 * replayed, those deltas are kept but marked not significant, and row statuses,
 * descendant flags, counts and the first divergence are recomputed to match.
 */
export function discountReplayedTiming(diff: RunDiff): RunDiff {
  const replayedRow = (r: DiffRow) => isReplayed(r.left?.span.attributes) || isReplayed(r.right?.span.attributes);
  if (!diff.rows.some(replayedRow)) return diff;

  const rows: DiffRow[] = diff.rows.map((r) => {
    if (!replayedRow(r) || r.status !== "modified") return r;
    const changes = r.changes.map((c) => (TIMING_FIELDS.has(c.field) ? { ...c, significant: false } : c));
    return { ...r, changes, status: changes.some((c) => c.significant) ? "modified" : "same" };
  });

  // Children always follow their parent, so a reverse pass sees every child first.
  const changedBelow = new Array<boolean>(rows.length).fill(false);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    rows[i] = { ...row, descendantsChanged: changedBelow[i]! };
    if (row.parentIndex !== null && (row.status !== "same" || changedBelow[i])) changedBelow[row.parentIndex] = true;
  }

  const counts = { same: 0, modified: 0, added: 0, removed: 0 };
  for (const r of rows) counts[r.status]++;
  return { ...diff, rows, firstDivergence: findFirstDivergence(rows), summary: { ...diff.summary, rows: counts } };
}

export interface RunSide {
  traceId: string;
  spans: Span[];
}

export interface Comparison {
  diff: RunDiff;
  /** One run is a replay of the other, so replayed steps' cost and latency were discounted. */
  replayPair: boolean;
}

export function compareRuns(a: RunSide, b: RunSide): Comparison {
  const diff = diffRuns(
    a.spans.map((s) => toWireSpan(a.traceId, s)),
    b.spans.map((s) => toWireSpan(b.traceId, s)),
  );
  const replayPair = replayInfo(b.spans)?.of === a.traceId || replayInfo(a.spans)?.of === b.traceId;
  return { diff: discountReplayedTiming(diff), replayPair };
}
