import { describe, expect, it } from 'vitest';
import { buildTree, diffRuns, type DiffRow, type Span } from '../src/index.js';
import { agent, llm, makeRun, mulberry32, shuffle, tool, type StepSpec } from './fixtures.js';

const TOOLS = ['web_search', 'calculator', 'notes', 'fetch'];
const MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-4o'];

function randomTree(rng: () => number, depth = 0): StepSpec {
  const kids: StepSpec[] = [];
  const n = depth >= 3 ? 0 : Math.floor(rng() * (depth === 0 ? 8 : 5));
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.2 && depth < 3) kids.push(randomTree(rng, depth + 1));
    else if (r < 0.6) kids.push(llm(MODELS[Math.floor(rng() * 3)]!, `prompt ${Math.floor(rng() * 5)}`, `answer ${Math.floor(rng() * 5)}`));
    else kids.push(tool(TOOLS[Math.floor(rng() * 4)]!, { q: Math.floor(rng() * 5) }, `result ${Math.floor(rng() * 5)}`));
  }
  return agent(`agent-${depth}-${Math.floor(rng() * 2)}`, kids, { input: 'task', output: `done ${Math.floor(rng() * 3)}` });
}

/** Randomly delete, insert, modify, swap models and reorder steps throughout a tree. */
function mutate(spec: StepSpec, rng: () => number): StepSpec {
  const kids = (spec.children ?? []).flatMap((c): StepSpec[] => {
    const r = rng();
    if (r < 0.1) return [];
    if (r < 0.2) return [mutate(c, rng), tool('notes', { q: 9 }, 'inserted')];
    if (r < 0.3 && c.kind === 'llm') return [{ ...c, model: 'gpt-4o-mini', name: 'chat gpt-4o-mini' }];
    if (r < 0.4) return [{ ...c, output: 'changed' }];
    return [mutate(c, rng)];
  });
  if (kids.length > 1 && rng() < 0.2) kids.push(kids.shift()!);
  return { ...spec, children: kids };
}

/**
 * Rebuild one side's tree from the diff rows (following parentIndex) and compare it to the
 * tree built directly from that run's spans: same nodes, same pre-order, same parents.
 */
function expectSideRebuildsRun(rows: DiffRow[], spans: Span[], side: 'left' | 'right') {
  const tree = buildTree(spans);
  const expected = tree.nodes.map((n) => [n.span.span_id, n.parent?.span.span_id ?? null]);
  const actual: [string, string | null][] = [];
  for (const row of rows) {
    const ref = row[side];
    if (!ref) continue;
    // The nearest ancestor row on this side must be this span's parent.
    let p = row.parentIndex;
    while (p !== null && !rows[p]![side]) p = rows[p]!.parentIndex;
    actual.push([ref.spanId, p === null ? null : rows[p]![side]!.spanId]);
  }
  expect(actual).toEqual(expected);
}

describe('properties', () => {
  it('diff(a, a) is all "same" with no divergence', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const spec = randomTree(mulberry32(seed));
      const spans = makeRun(spec);
      const d = diffRuns(spans, shuffle(spans, seed));
      expect(d.rows.every((r) => r.status === 'same' && r.left!.spanId === r.right!.spanId)).toBe(true);
      expect(d.rows).toHaveLength(spans.length);
      expect(d.firstDivergence).toBeNull();
    }
  });

  it('the left side of the alignment rebuilds run A and the right side rebuilds run B', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rng = mulberry32(seed * 7919);
      const base = randomTree(rng);
      const a = makeRun(base, 'a');
      let b = makeRun(mutate(base, rng), 'b');
      if (seed % 10 === 0) b = b.filter((s) => s.parent_span_id !== null); // orphans
      const d = diffRuns(a, shuffle(b, seed));
      expectSideRebuildsRun(d.rows, a, 'left');
      expectSideRebuildsRun(d.rows, b, 'right');
      // Every row is consistent with its status.
      for (const r of d.rows) {
        if (r.status === 'added') expect(r.left).toBeUndefined();
        if (r.status === 'removed') expect(r.right).toBeUndefined();
        if (r.status === 'same' || r.status === 'modified') expect(r.left && r.right).toBeTruthy();
        if (r.status === 'same') expect(r.changes.every((c) => !c.significant)).toBe(true);
      }
    }
  });

  it('is symmetric: swapping sides swaps added/removed and negates deltas', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const base = randomTree(rng);
      const a = makeRun(base, 'a');
      const b = makeRun(mutate(base, rng), 'b');
      const ab = diffRuns(a, b);
      const ba = diffRuns(b, a);
      const flip = { added: 'removed', removed: 'added', same: 'same', modified: 'modified' } as const;
      const countOf = (d: typeof ab, s: DiffRow['status']) => d.rows.filter((r) => r.status === s).length;
      expect(countOf(ba, 'added')).toBe(countOf(ab, flip.added));
      expect(countOf(ba, 'removed')).toBe(countOf(ab, flip.removed));
      expect(ba.summary.delta.totalTokens + ab.summary.delta.totalTokens).toBe(0);
      expect(ba.summary.delta.toolCalls + ab.summary.delta.toolCalls).toBe(0);
    }
  });
});
