import { describe, expect, it } from 'vitest';
import { buildTree, modelFamily, parseTimestamp, spanSignature } from '../src/index.js';
import { agent, llm, makeRun, shuffle, tool } from './fixtures.js';

describe('parseTimestamp', () => {
  it('keeps nanosecond precision that Date.parse would drop', () => {
    const a = parseTimestamp('2026-01-01T00:00:00.000000001Z');
    const b = parseTimestamp('2026-01-01T00:00:00.000000002Z');
    expect(b - a).toBe(1n);
  });

  it('handles missing and short fractions and numeric offsets', () => {
    expect(parseTimestamp('2026-01-01T00:00:01Z') - parseTimestamp('2026-01-01T00:00:00.5Z')).toBe(500_000_000n);
    expect(parseTimestamp('2026-01-01T01:00:00+01:00')).toBe(parseTimestamp('2026-01-01T00:00:00Z'));
  });
});

describe('buildTree', () => {
  it('builds the tree regardless of storage order, children sorted by start_time', () => {
    const spans = makeRun(agent('root', [tool('a', 1, 1), tool('b', 2, 2), agent('sub', [tool('c', 3, 3)])]));
    const tree = buildTree(shuffle(spans, 7));
    expect(tree.roots).toHaveLength(1);
    expect(tree.nodes.map((n) => n.span.name)).toEqual(['root', 'a', 'b', 'sub', 'c']);
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 1, 1, 1, 2]);
    expect(tree.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('groups orphans (missing parent) under a placeholder for that parent, in time order', () => {
    const spans = makeRun(agent('root', [agent('lost', [tool('x', 1, 1)]), tool('y', 2, 2)]));
    const root = spans.find((s) => s.name === 'root')!;
    // Drop the root (it arrives last while a run is in flight): "lost" and "y" are orphans.
    const tree = buildTree(spans.filter((s) => s !== root));
    expect(tree.roots).toHaveLength(1);
    const ph = tree.roots[0]!;
    expect(ph.placeholder).toBe(true);
    expect(ph.span.span_id).toBe(root.span_id);
    expect(ph.children.map((c) => c.span.name)).toEqual(['lost', 'y']);
    expect(ph.children.every((c) => c.orphan)).toBe(true);
    expect(ph.children[0]!.children.map((c) => c.span.name)).toEqual(['x']);
    expect(tree.spanCount).toBe(3); // placeholders are not spans
  });

  it('gives orphans with different missing parents separate placeholders', () => {
    const a = makeRun(agent('r1', [tool('x', 1, 1)]), 'a');
    const b = makeRun(agent('r2', [tool('y', 1, 1)]), 'b');
    const tree = buildTree([a[1]!, b[1]!]);
    expect(tree.roots.map((r) => r.placeholder)).toEqual([true, true]);
    expect(tree.roots.map((r) => r.children[0]!.span.name)).toEqual(['x', 'y']);
  });

  it('supports multiple true roots and breaks parent cycles instead of losing spans', () => {
    const spans = makeRun([agent('first'), agent('second')]);
    expect(buildTree(spans).roots.map((r) => r.span.name)).toEqual(['first', 'second']);

    const cyc = makeRun(agent('p', [agent('q')]));
    cyc[0] = { ...cyc[0]!, parent_span_id: cyc[1]!.span_id }; // p -> q -> p
    const tree = buildTree(cyc);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.orphan).toBe(true);
  });

  it('ignores duplicate span ids (ingest is idempotent, retries resend spans)', () => {
    const spans = makeRun(agent('root', [tool('a', 1, 1)]));
    expect(buildTree([...spans, ...spans]).nodes).toHaveLength(2);
  });
});

describe('spanSignature', () => {
  it('strips the model from llm span names so a model swap keeps the same identity', () => {
    const [a] = makeRun(llm('claude-sonnet-4-5', 'x', 'y'));
    const [b] = makeRun(llm('gpt-4o', 'x', 'y'));
    const sa = spanSignature(a!);
    const sb = spanSignature(b!);
    expect(sa.label).toBe('chat');
    expect(sa.compatKey).toBe(sb.compatKey);
    expect(sa.key).not.toBe(sb.key);
    expect(sa.key).toBe('llm:chat@claude-sonnet');
  });

  it('uses gen_ai.tool.name for tools', () => {
    const [t] = makeRun(tool('web_search', 'q', 'r'));
    expect(spanSignature(t!).key).toBe('tool:web_search#web_search');
  });

  it('derives model families from versioned model ids', () => {
    expect(modelFamily('claude-sonnet-4-5-20250929')).toBe('claude-sonnet');
    expect(modelFamily('claude-3-5-sonnet-20241022')).toBe('claude-sonnet');
    expect(modelFamily('anthropic/claude-haiku-4.5')).toBe('claude-haiku');
    expect(modelFamily('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(modelFamily('gpt-4.1')).toBe('gpt');
    expect(modelFamily(null)).toBeNull();
  });
});
