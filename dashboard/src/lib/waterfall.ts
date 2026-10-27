/**
 * Pure layout math for the run timeline waterfall and span tree.
 * No React, no DOM: everything here is unit tested.
 */

export interface TimedSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: string;
  endTime: string;
}

export interface SpanNode<S extends TimedSpan> {
  span: S;
  children: SpanNode<S>[];
}

export interface WaterfallRow<S extends TimedSpan> {
  span: S;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** Bar start as a percentage of the trace window, 0..100. */
  offsetPct: number;
  /** Bar width as a percentage of the trace window, 0..100. */
  widthPct: number;
}

export interface TraceWindow {
  startMs: number;
  endMs: number;
  totalMs: number;
}

const toMs = (iso: string): number => new Date(iso).getTime();

function compareSpans(a: TimedSpan, b: TimedSpan): number {
  return toMs(a.startTime) - toMs(b.startTime) || a.name.localeCompare(b.name) || a.spanId.localeCompare(b.spanId);
}

/**
 * Builds a forest from flat spans. Siblings are ordered by start time.
 * Spans whose parent is missing (spans arrive out of order, or a parent was
 * dropped) are promoted to roots rather than hidden.
 */
export function buildSpanTree<S extends TimedSpan>(spans: readonly S[]): SpanNode<S>[] {
  const nodes = new Map<string, SpanNode<S>>();
  for (const span of spans) nodes.set(span.spanId, { span, children: [] });

  const roots: SpanNode<S>[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId && parentId !== node.span.spanId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: SpanNode<S>[]) => {
    list.sort((a, b) => compareSpans(a.span, b.span));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** The time range covered by all spans. A zero-length trace gets a 1 ms window to avoid division by zero. */
export function traceWindow(spans: readonly TimedSpan[]): TraceWindow {
  if (spans.length === 0) return { startMs: 0, endMs: 1, totalMs: 1 };
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const s of spans) {
    startMs = Math.min(startMs, toMs(s.startTime));
    endMs = Math.max(endMs, toMs(s.endTime));
  }
  const totalMs = Math.max(endMs - startMs, 1);
  return { startMs, endMs: startMs + totalMs, totalMs };
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** Positions one span's bar inside the trace window, as percentages. */
export function barGeometry(span: TimedSpan, window: TraceWindow): { offsetPct: number; widthPct: number } {
  const start = toMs(span.startTime);
  const end = Math.max(toMs(span.endTime), start);
  const offsetPct = clampPct(((start - window.startMs) / window.totalMs) * 100);
  const widthPct = Math.min(clampPct(((end - start) / window.totalMs) * 100), 100 - offsetPct);
  return { offsetPct, widthPct };
}

/**
 * Depth-first flattening of the tree into the rows the waterfall renders.
 * Descendants of a collapsed span are skipped; the collapsed span itself stays.
 */
export function layoutWaterfall<S extends TimedSpan>(
  roots: readonly SpanNode<S>[],
  window: TraceWindow,
  collapsed: ReadonlySet<string> = new Set(),
): WaterfallRow<S>[] {
  const rows: WaterfallRow<S>[] = [];
  const visit = (node: SpanNode<S>, depth: number) => {
    const isCollapsed = collapsed.has(node.span.spanId);
    rows.push({
      span: node.span,
      depth,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed && node.children.length > 0,
      ...barGeometry(node.span, window),
    });
    if (!isCollapsed) for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/**
 * "Nice" axis ticks (1, 2, 5 x 10^n) from 0 up to totalMs, aiming for about
 * `target` intervals. Always starts at 0.
 */
export function timeTicks(totalMs: number, target = 5): number[] {
  if (!(totalMs > 0)) return [0];
  const rough = totalMs / Math.max(target, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs + step * 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

/** Span ids along the path from a root down to (and including) `spanId`. */
export function ancestorPath(spans: readonly TimedSpan[], spanId: string): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(spanId);
  while (current && !seen.has(current.spanId)) {
    seen.add(current.spanId);
    path.unshift(current.spanId);
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return path;
}
