import { describe, expect, it } from 'vitest';
import { alignSequences, type AlignmentCosts } from '../src/index.js';
import { mulberry32 } from './fixtures.js';

/** Unit-cost alignment over letters: equal = 0, different letters cannot pair. */
function letters(a: string, b: string): AlignmentCosts {
  return {
    n: a.length,
    m: b.length,
    gapA: () => 1,
    gapB: () => 1,
    pair: (i, j) => (a[i] === b[j] ? 0 : Infinity),
  };
}

const render = (a: string, b: string, pairs: ReturnType<typeof alignSequences>['pairs']) =>
  pairs.map(([i, j]) => (i >= 0 && j >= 0 ? a[i] : i >= 0 ? `-${a[i]}` : `+${b[j]}`)).join(' ');

describe('alignSequences', () => {
  it('computes an optimal alignment (here equivalent to LCS)', () => {
    const r = alignSequences(letters('ABCBDAB', 'BDCABA'));
    expect(r.cost).toBe(13 - 2 * 4); // n + m - 2·LCS, LCS = 4
    expect(r.mode).toBe('exact');
  });

  it('weighs gaps: prefers to gap a cheap item rather than an expensive one', () => {
    // X (weight 10) and y (weight 1) swap places: keep X matched, move y.
    const w = { X: 10, y: 1 } as Record<string, number>;
    const a = 'yX';
    const b = 'Xy';
    const r = alignSequences({
      n: 2,
      m: 2,
      gapA: (i) => w[a[i]!]!,
      gapB: (j) => w[b[j]!]!,
      pair: (i, j) => (a[i] === b[j] ? 0 : Infinity),
    });
    expect(r.cost).toBe(2);
    expect(render(a, b, r.pairs)).toBe('-y X +y');
  });

  it('puts removals before additions inside a gap run (stable, readable output)', () => {
    const r = alignSequences(letters('AxB', 'AyB'));
    expect(render('AxB', 'AyB', r.pairs)).toBe('A -x +y B');
  });

  it('banded mode matches exact cost when the optimal path stays near the diagonal', () => {
    const rng = mulberry32(9);
    for (let t = 0; t < 30; t++) {
      const n = 300 + Math.floor(rng() * 50);
      const a = Array.from({ length: n }, () => 'ABCD'[Math.floor(rng() * 4)]).join('');
      // A few local edits: the optimal path is near-diagonal.
      let b = a;
      for (let e = 0; e < 5; e++) {
        const p = Math.floor(rng() * b.length);
        b = rng() < 0.5 ? b.slice(0, p) + b.slice(p + 1) : b.slice(0, p) + 'E' + b.slice(p);
      }
      const exact = alignSequences(letters(a, b));
      const banded = alignSequences(letters(a, b), { maxCells: 1000, bandRadius: 16 });
      expect(banded.mode).toBe('banded');
      expect(banded.cost).toBe(exact.cost);
      expect(banded.cells).toBeLessThan(exact.cells / 5);
    }
  });

  it('banded mode is always a valid alignment even when it is not optimal', () => {
    const a = 'ABCDEFGHIJ'.repeat(20);
    const b = 'JIHGFEDCBA'.repeat(20);
    const r = alignSequences(letters(a, b), { maxCells: 100, bandRadius: 2 });
    expect(r.pairs.filter(([i]) => i >= 0).map(([i]) => i)).toEqual([...Array(a.length).keys()]);
    expect(r.pairs.filter(([, j]) => j >= 0).map(([, j]) => j)).toEqual([...Array(b.length).keys()]);
  });

  it('handles empty sides and very unequal lengths', () => {
    expect(alignSequences(letters('', '')).pairs).toEqual([]);
    expect(render('', 'ab', alignSequences(letters('', 'ab')).pairs)).toBe('+a +b');
    const long = 'A'.repeat(2000);
    const r = alignSequences(letters('A', long), { maxCells: 100, bandRadius: 4 });
    expect(r.cost).toBe(1999);
  });
});
