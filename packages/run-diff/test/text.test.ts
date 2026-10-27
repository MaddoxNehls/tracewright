import { describe, expect, it } from 'vitest';
import { diffPayload, diffRuns, diffText, formatPayload, type DiffOp } from '../src/index.js';
import { makeRun, researchRun } from './fixtures.js';
import { mulberry32 } from './fixtures.js';

const apply = (ops: DiffOp[], side: 'old' | 'new') =>
  ops.filter((o) => o.op === 'equal' || o.op === (side === 'old' ? 'delete' : 'insert')).map((o) => o.text).join('');

describe('diffText (Myers)', () => {
  it('identical text has no hunks', () => {
    const d = diffText('a\nb\n', 'a\nb\n');
    expect(d).toMatchObject({ identical: true, hunks: [], insertions: 0, deletions: 0, exact: true });
  });

  it('produces unified-style line hunks with context and line numbers', () => {
    const a = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n');
    const b = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n');
    const d = diffText(a, b, { context: 1 });
    expect(d.insertions).toBe(3); // THREE, "nine\n" (gained a newline), ten
    expect(d.deletions).toBe(2); // three, "nine" without newline
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]).toEqual({
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 3,
      lines: [
        { op: 'equal', text: 'two', oldLine: 2, newLine: 2 },
        { op: 'delete', text: 'three', oldLine: 3 },
        { op: 'insert', text: 'THREE', newLine: 3 },
        { op: 'equal', text: 'four', oldLine: 4, newLine: 4 },
      ],
    });
  });

  it('word granularity yields inline segments', () => {
    const d = diffText('The capital is Paris.', 'The capital is Lyon.', { granularity: 'word' });
    expect(d.ops).toEqual([
      { op: 'equal', text: 'The capital is ' },
      { op: 'delete', text: 'Paris' },
      { op: 'insert', text: 'Lyon' },
      { op: 'equal', text: '.' },
    ]);
  });

  it('finds a minimal edit script (classic Myers example ABCABBA -> CBABAC has D=5)', () => {
    const d = diffText('ABCABBA', 'CBABAC', { granularity: 'char' });
    expect(d.insertions + d.deletions).toBe(5);
    expect(apply(d.ops, 'old')).toBe('ABCABBA');
    expect(apply(d.ops, 'new')).toBe('CBABAC');
  });

  it('round-trips random edits at every granularity', () => {
    const rng = mulberry32(42);
    const words = ['alpha', 'beta', 'gamma', 'delta', '\n', ' ', 'x', '.', 'Ω'];
    const rand = (n: number) => Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join('');
    for (let i = 0; i < 200; i++) {
      const a = rand(Math.floor(rng() * 40));
      const b = rng() < 0.5 ? rand(Math.floor(rng() * 40)) : a.slice(0, 10) + rand(5) + a.slice(15);
      for (const granularity of ['line', 'word', 'char'] as const) {
        const d = diffText(a, b, { granularity });
        expect(apply(d.ops, 'old')).toBe(a);
        expect(apply(d.ops, 'new')).toBe(b);
      }
    }
  });

  it('degrades to a whole replacement past maxEditDistance instead of blowing up', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n');
    const t0 = performance.now();
    const d = diffText(a, b, { maxEditDistance: 100 });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.exact).toBe(false);
    expect(apply(d.ops, 'old')).toBe(a);
    expect(apply(d.ops, 'new')).toBe(b);
  });
});

describe('payload helpers', () => {
  it('formats JSON canonically (sorted keys) and strings verbatim', () => {
    expect(formatPayload({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{\n  "a": [\n    {\n      "c": 3,\n      "d": 2\n    }\n  ],\n  "b": 1\n}');
    expect(formatPayload('hello')).toBe('hello');
    expect(formatPayload(null)).toBe('');
  });

  it('diffs a row output lazily', () => {
    const right = makeRun(researchRun(), 'b');
    right[right.length - 1]!.output = 'France is about 0.85% of the world population.';
    const d = diffRuns(makeRun(researchRun(), 'a'), right);
    const row = d.rows[5]!;
    const td = diffPayload(row, 'output', { granularity: 'word' });
    expect(td.ops.filter((o) => o.op !== 'equal')).toEqual([
      { op: 'delete', text: '84' },
      { op: 'insert', text: '85' },
    ]);
  });
});
