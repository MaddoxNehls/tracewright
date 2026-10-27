import { alignSequences, DEFAULT_BAND_RADIUS, DEFAULT_MAX_CELLS, type AlignedPair } from './align.js';
import { computeFeatures, similarity, spanCost, spanTokens, type NodeFeatures } from './features.js';
import { buildTree } from './tree.js';
import type {
  AlignmentStats,
  ChangeField,
  DiffOptions,
  DiffRow,
  DiffSummary,
  DiffThresholds,
  Divergence,
  DivergenceReason,
  FieldChange,
  RowStatus,
  RunDiff,
  RunTotals,
  RunTree,
  Span,
  SpanNode,
  Threshold,
} from './types.js';

export const DEFAULT_THRESHOLDS: DiffThresholds = {
  latencyMs: { abs: 500, rel: 0.5 },
  costUsd: { abs: 0.0005, rel: 0.25 },
  tokens: { abs: 50, rel: 0.25 },
};

/** Fields that are fixed before a step runs vs. produced when it finishes (Euler tour). */
const ENTER_FIELDS: ReadonlySet<ChangeField> = new Set(['model', 'input']);
const EXIT_FIELDS: ReadonlySet<ChangeField> = new Set(['status', 'error', 'output', 'tokens', 'cost', 'latency']);

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
const roundUsd = (x: number) => round(x, 9);
const roundMs = (x: number) => round(x, 6);

/**
 * Diff two runs. Rows come back in pre-order of the merged tree, ready to render side by side.
 *
 * 1. Build both span trees (see buildTree).
 * 2. Align the two top-level lists, then recursively the children of every aligned pair,
 *    with a weighted edit-distance DP (see alignSequences). Unaligned nodes are emitted as
 *    added/removed together with their whole subtree.
 * 3. Compare each aligned pair field by field (FieldChange), applying noise thresholds to
 *    metrics.
 * 4. Find the first divergence along the Euler tour of the merged tree and total the summary.
 */
export function diffRuns(left: readonly Span[], right: readonly Span[], options: DiffOptions = {}): RunDiff {
  const thresholds: DiffThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const alignOpts = {
    maxCells: options.maxCells ?? DEFAULT_MAX_CELLS,
    bandRadius: options.bandRadius ?? DEFAULT_BAND_RADIUS,
  };

  const lt = buildTree(left);
  const rt = buildTree(right);
  const interner = new Map<string, number>();
  const lf = computeFeatures(lt.nodes, interner);
  const rf = computeFeatures(rt.nodes, interner);

  const rows: DiffRow[] = [];
  const rowHash: number[] = []; // subtree hash of the row's node, for move detection
  const alignment: AlignmentStats = { mode: 'exact', cells: 0, alignments: 0 };

  const emitGap = (node: SpanNode, side: 'left' | 'right', depth: number, parentIndex: number | null) => {
    const f = (side === 'left' ? lf : rf).get(node)!;
    const index = rows.length;
    const row: DiffRow = {
      status: side === 'left' ? 'removed' : 'added',
      [side]: f.ref,
      depth,
      parentIndex,
      end: index + 1,
      descendantsChanged: false,
      changes: [],
    };
    rows.push(row);
    rowHash.push(f.subtreeHash);
    for (const child of node.children) emitGap(child, side, depth + 1, index);
    row.end = rows.length;
  };

  const emitPair = (a: SpanNode, b: SpanNode, depth: number, parentIndex: number | null) => {
    const fa = lf.get(a)!;
    const fb = rf.get(b)!;
    const changes = compareSteps(fa, fb, thresholds);
    const index = rows.length;
    const row: DiffRow = {
      status: changes.some((c) => c.significant) ? 'modified' : 'same',
      left: fa.ref,
      right: fb.ref,
      depth,
      parentIndex,
      end: index + 1,
      descendantsChanged: false,
      changes,
    };
    rows.push(row);
    rowHash.push(fa.subtreeHash);
    alignChildren(a.children, b.children, depth + 1, index);
    row.end = rows.length;
  };

  const alignChildren = (as: SpanNode[], bs: SpanNode[], depth: number, parentIndex: number | null) => {
    const fa = as.map((n) => lf.get(n)!);
    const fb = bs.map((n) => rf.get(n)!);
    for (const [i, j] of alignSiblings(fa, fb, alignOpts, alignment)) {
      if (i >= 0 && j >= 0) emitPair(as[i]!, bs[j]!, depth, parentIndex);
      else if (i >= 0) emitGap(as[i]!, 'left', depth, parentIndex);
      else emitGap(bs[j]!, 'right', depth, parentIndex);
    }
  };

  alignChildren(lt.roots, rt.roots, 0, null);

  // Bottom-up: children always come after their parent in pre-order.
  for (let k = rows.length - 1; k >= 0; k--) {
    const row = rows[k]!;
    if (row.parentIndex !== null && (row.status !== 'same' || row.descendantsChanged)) {
      rows[row.parentIndex]!.descendantsChanged = true;
    }
  }
  linkMoves(rows, rowHash);

  return {
    rows,
    firstDivergence: findFirstDivergence(rows),
    summary: summarize(lt, rt, rows),
    alignment,
  };
}

/**
 * Align two sibling lists. Fast paths: identical lists pair up one-to-one (a zero-cost
 * alignment is optimal because all costs are ≥ 0), and empty lists are pure gaps. Otherwise
 * run the DP with:
 *
 *   gap(x)     = weight(x)                       (subtree size: dropping a big subtree costs more)
 *   pair(x, y) = (1 − sim(x, y)) · (w(x) + w(y))  (∞ when signatures are incompatible)
 *
 * so pairing two compatible steps always costs strictly less than deleting one and inserting
 * the other, and the DP only leaves a compatible step unpaired when that lets better pairs
 * line up.
 *
 * Before falling back to the banded DP, an over-size list is trimmed of its common prefix and
 * suffix of identical subtrees. That is a heuristic, like the band itself, so it only runs in
 * the fallback.
 */
function alignSiblings(
  fa: NodeFeatures[],
  fb: NodeFeatures[],
  opts: { maxCells: number; bandRadius: number },
  stats: AlignmentStats,
): AlignedPair[] {
  const n = fa.length;
  const m = fb.length;
  if (n === m && fa.every((f, i) => f.subtreeHash === fb[i]!.subtreeHash)) {
    return fa.map((_, i) => [i, i] as const);
  }

  let head = 0;
  let tail = 0;
  if ((n + 1) * (m + 1) > opts.maxCells) {
    while (head < n && head < m && fa[head]!.subtreeHash === fb[head]!.subtreeHash) head++;
    while (tail < n - head && tail < m - head && fa[n - 1 - tail]!.subtreeHash === fb[m - 1 - tail]!.subtreeHash) tail++;
  }
  const xa = fa.slice(head, n - tail);
  const xb = fb.slice(head, m - tail);

  const result = alignSequences(
    {
      n: xa.length,
      m: xb.length,
      gapA: (i) => xa[i]!.weight,
      gapB: (j) => xb[j]!.weight,
      pair: (i, j) => {
        const a = xa[i]!;
        const b = xb[j]!;
        const s = similarity(a, b);
        return s < 0 ? Infinity : (1 - s) * (a.weight + b.weight);
      },
    },
    opts,
  );
  stats.alignments++;
  stats.cells += result.cells;
  if (result.mode === 'banded') stats.mode = 'banded';

  const pairs: AlignedPair[] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  for (const [i, j] of result.pairs) pairs.push([i < 0 ? -1 : i + head, j < 0 ? -1 : j + head]);
  for (let k = tail; k > 0; k--) pairs.push([n - k, m - k]);
  return pairs;
}

function significant(l: number | null, r: number | null, t: Threshold): boolean {
  if (l === null || r === null) return false;
  const d = Math.abs(r - l);
  if (d === 0 || d < t.abs) return false;
  return l === 0 ? true : d / Math.abs(l) >= t.rel;
}

function metricChange(
  field: 'tokens' | 'cost' | 'latency',
  l: number | null,
  r: number | null,
  left: unknown,
  right: unknown,
  t: Threshold,
  roundFn: (x: number) => number,
): FieldChange | null {
  if (l === r) return null;
  const change: FieldChange = { field, category: 'metric', left, right, significant: significant(l, r, t) };
  if (l !== null && r !== null) {
    change.delta = roundFn(r - l);
    if (l !== 0) change.ratio = round((r - l) / Math.abs(l), 6);
  }
  return change;
}

/** Field-by-field comparison of two aligned steps. */
function compareSteps(a: NodeFeatures, b: NodeFeatures, t: DiffThresholds): FieldChange[] {
  if (a.node.placeholder || b.node.placeholder) {
    if (a.node.placeholder && b.node.placeholder) return [];
    return [
      {
        field: 'presence',
        category: 'recording',
        left: a.node.placeholder ? 'missing' : 'recorded',
        right: b.node.placeholder ? 'missing' : 'recorded',
        significant: true,
      },
    ];
  }

  const changes: FieldChange[] = [];
  const sa = a.node.span;
  const sb = b.node.span;
  const behavior = (field: ChangeField, left: unknown, right: unknown) =>
    changes.push({ field, category: 'behavior', left, right, significant: true });

  if (a.model !== b.model) behavior('model', a.model, b.model);
  if (sa.status !== sb.status) behavior('status', sa.status, sb.status);
  if (a.errorText !== b.errorText) behavior('error', sa.error, sb.error);
  if (a.inputText !== b.inputText) behavior('input', sa.input, sb.input);
  if (a.outputText !== b.outputText) behavior('output', sa.output, sb.output);

  const ta = a.ref.tokens;
  const tb = b.ref.tokens;
  const tokensDiffer = ta.input !== tb.input || ta.output !== tb.output;
  const tok = tokensDiffer ? metricChange('tokens', ta.total, tb.total, ta, tb, t.tokens, (x) => x) : null;
  if (tokensDiffer) {
    // Input/output may shift with the same total: still report it, as not significant.
    changes.push(tok ?? { field: 'tokens', category: 'metric', left: ta, right: tb, delta: 0, ratio: 0, significant: false });
  }
  const cost = metricChange('cost', a.ref.costUsd, b.ref.costUsd, a.ref.costUsd, b.ref.costUsd, t.costUsd, roundUsd);
  if (cost) changes.push(cost);
  const lat = metricChange('latency', a.ref.durationMs, b.ref.durationMs, a.ref.durationMs, b.ref.durationMs, t.latencyMs, roundMs);
  if (lat) changes.push(lat);
  return changes;
}

/**
 * First divergence along the Euler tour of the merged tree. A span is visited twice: on
 * *enter* (was it added or removed, did its model or input change?) and on *exit*, after all
 * its children (did its output, status, error or significant metrics change?). This matches
 * execution order: a parent's input exists before its children run, and its output after.
 * So when a child diverges, the parent's changed output is correctly attributed downstream
 * of it, and the reported point is the earliest cause rather than the root.
 */
export function findFirstDivergence(rows: readonly DiffRow[]): Divergence | null {
  const reasonsOf = (row: DiffRow, fields: ReadonlySet<ChangeField>): DivergenceReason[] =>
    row.changes.filter((c) => c.significant && c.category !== 'recording' && fields.has(c.field)).map((c) => c.field);

  const stack: number[] = [];
  const exit = (k: number): Divergence | null => {
    const reasons = reasonsOf(rows[k]!, EXIT_FIELDS);
    return reasons.length ? { rowIndex: k, phase: 'exit', reasons } : null;
  };
  for (let k = 0; k < rows.length; k++) {
    while (stack.length && rows[stack[stack.length - 1]!]!.end <= k) {
      const d = exit(stack.pop()!);
      if (d) return d;
    }
    const row = rows[k]!;
    if (row.status === 'added' || row.status === 'removed') return { rowIndex: k, phase: 'enter', reasons: [row.status] };
    const reasons = reasonsOf(row, ENTER_FIELDS);
    if (reasons.length) return { rowIndex: k, phase: 'enter', reasons };
    stack.push(k);
  }
  while (stack.length) {
    const d = exit(stack.pop()!);
    if (d) return d;
  }
  return null;
}

/**
 * Pair each top-most removed subtree with an identical top-most added subtree: the step moved
 * (e.g. two tools swapped order). Alignment is order-preserving, so a move always surfaces as
 * a removal plus an addition. This labels the pair without changing the alignment.
 */
function linkMoves(rows: DiffRow[], hashes: number[]): void {
  const isTopGap = (r: DiffRow) => r.parentIndex === null || rows[r.parentIndex]!.status !== r.status;
  const removed = new Map<number, number[]>();
  rows.forEach((r, k) => {
    if (r.status === 'removed' && isTopGap(r)) {
      const list = removed.get(hashes[k]!) ?? [];
      list.push(k);
      removed.set(hashes[k]!, list);
    }
  });
  rows.forEach((r, k) => {
    if (r.status !== 'added' || !isTopGap(r)) return;
    const k2 = removed.get(hashes[k]!)?.shift();
    if (k2 === undefined) return;
    r.movedFrom = k2;
    rows[k2]!.movedTo = k;
  });
}

function totals(tree: RunTree): RunTotals {
  const t: RunTotals = {
    spans: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: null,
    durationMs: 0,
    status: 'ok',
    errorSpans: 0,
  };
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const node of tree.nodes) {
    if (node.placeholder) continue;
    const s = node.span;
    t.spans++;
    if (s.kind === 'llm') t.llmCalls++;
    if (s.kind === 'tool') t.toolCalls++;
    if (s.status === 'error') {
      t.errorSpans++;
      if (s.parent_span_id === null) t.status = 'error';
    }
    const tokens = spanTokens(s);
    t.inputTokens += tokens.input ?? 0;
    t.outputTokens += tokens.output ?? 0;
    const cost = spanCost(s);
    if (cost !== null) t.costUsd = roundUsd((t.costUsd ?? 0) + cost);
    if (min === null || node.startNs < min) min = node.startNs;
    if (max === null || node.endNs > max) max = node.endNs;
  }
  t.totalTokens = t.inputTokens + t.outputTokens;
  t.durationMs = min === null || max === null ? 0 : Number(max - min) / 1e6;
  return t;
}

function summarize(lt: RunTree, rt: RunTree, rows: DiffRow[]): DiffSummary {
  const left = totals(lt);
  const right = totals(rt);
  const counts: Record<RowStatus, number> = { same: 0, modified: 0, added: 0, removed: 0 };
  for (const r of rows) counts[r.status]++;
  return {
    left,
    right,
    delta: {
      spans: right.spans - left.spans,
      llmCalls: right.llmCalls - left.llmCalls,
      toolCalls: right.toolCalls - left.toolCalls,
      inputTokens: right.inputTokens - left.inputTokens,
      outputTokens: right.outputTokens - left.outputTokens,
      totalTokens: right.totalTokens - left.totalTokens,
      costUsd: left.costUsd === null || right.costUsd === null ? null : roundUsd(right.costUsd - left.costUsd),
      durationMs: roundMs(right.durationMs - left.durationMs),
    },
    statusChanged: left.status !== right.status,
    rows: counts,
  };
}
