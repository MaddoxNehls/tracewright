import type { RunTree, Span, SpanNode } from './types.js';

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an RFC3339(Nano) timestamp to nanoseconds since the epoch, as a bigint.
 * `Date.parse` keeps only milliseconds, and spans that are microseconds apart must still sort
 * correctly. Unparseable values become 0 so a malformed span sorts first, not fatally.
 */
export function parseTimestamp(value: string): bigint {
  const m = RFC3339.exec(value);
  if (!m) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : 0n;
  }
  const seconds = Date.parse(m[1]! + m[3]!);
  if (!Number.isFinite(seconds)) return 0n;
  const frac = BigInt(((m[2] ?? '') + '000000000').slice(0, 9));
  return BigInt(seconds) * 1_000_000n + frac;
}

const byTime = (a: SpanNode, b: SpanNode): number =>
  a.startNs !== b.startNs
    ? a.startNs < b.startNs ? -1 : 1
    : a.endNs !== b.endNs
      ? a.endNs < b.endNs ? -1 : 1
      : a.span.span_id < b.span.span_id ? -1 : a.span.span_id > b.span.span_id ? 1 : 0;

function makeNode(span: Span): SpanNode {
  return {
    span,
    parent: null,
    children: [],
    depth: 0,
    index: -1,
    orphan: false,
    placeholder: false,
    startNs: parseTimestamp(span.start_time),
    endNs: parseTimestamp(span.end_time),
  };
}

/**
 * Build the span tree of one run. O(n log n).
 *
 * - Spans may arrive in any order; duplicates (same span_id, from SDK retries) are collapsed.
 * - Children are ordered by start_time (then end_time, then span_id, for determinism).
 * - Several spans with `parent_span_id: null` give several roots.
 * - Orphans, whose parent was never recorded, are grouped under one synthetic placeholder per
 *   missing parent id. Ingest notes that the root "may come last", so an in-flight run is
 *   usually a forest of orphans that share a missing parent. Keeping them together lets the
 *   placeholder align with the real root of the other run.
 * - Parent cycles (malformed data) are broken at the earliest span, which becomes an orphan
 *   root, so no span is ever dropped.
 */
export function buildTree(spans: readonly Span[]): RunTree {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) if (!byId.has(span.span_id)) byId.set(span.span_id, makeNode(span));
  const spanCount = byId.size;

  const top: SpanNode[] = [];
  const placeholders = new Map<string, SpanNode>();
  for (const node of byId.values()) {
    const pid = node.span.parent_span_id;
    if (pid === null || pid === undefined || pid === '') {
      top.push(node);
      continue;
    }
    const parent = pid === node.span.span_id ? undefined : byId.get(pid);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
      continue;
    }
    node.orphan = true;
    let ph = placeholders.get(pid);
    if (!ph) {
      ph = makeNode({
        trace_id: node.span.trace_id,
        span_id: pid,
        parent_span_id: null,
        name: '(missing span)',
        kind: 'custom',
        start_time: node.span.start_time,
        end_time: node.span.end_time,
        status: 'ok',
        error: null,
        attributes: {},
        input: null,
        output: null,
      });
      ph.placeholder = true;
      placeholders.set(pid, ph);
      top.push(ph);
    }
    node.parent = ph;
    ph.children.push(node);
  }
  // A placeholder spans its orphans' time range.
  for (const ph of placeholders.values()) {
    for (const c of ph.children) {
      if (c.startNs < ph.startNs) {
        ph.startNs = c.startNs;
        ph.span.start_time = c.span.start_time;
      }
      if (c.endNs > ph.endNs) {
        ph.endNs = c.endNs;
        ph.span.end_time = c.span.end_time;
      }
    }
  }

  const nodes: SpanNode[] = [];
  const visit = (roots: SpanNode[]) => {
    // Iterative pre-order: deep chains must not overflow the call stack.
    const stack = roots.slice().reverse();
    while (stack.length) {
      const node = stack.pop()!;
      node.index = nodes.length;
      node.depth = node.parent ? node.parent.depth + 1 : 0;
      nodes.push(node);
      node.children.sort(byTime);
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  };

  top.sort(byTime);
  visit(top);

  // Anything not reached sits on a parent cycle. Break each cycle at its earliest span.
  if (nodes.length < byId.size + placeholders.size) {
    const unreached = [...byId.values()].filter((n) => n.index < 0).sort(byTime);
    for (const node of unreached) {
      if (node.index >= 0) continue; // reached via an earlier cycle break
      const siblings = node.parent!.children;
      siblings.splice(siblings.indexOf(node), 1);
      node.parent = null;
      node.orphan = true;
      top.push(node);
      visit([node]);
    }
    top.sort(byTime);
    // Restore global pre-order over the final, time-sorted roots.
    nodes.length = 0;
    for (const n of byId.values()) n.index = -1;
    visit(top);
  }

  return { roots: top, nodes, spanCount };
}
