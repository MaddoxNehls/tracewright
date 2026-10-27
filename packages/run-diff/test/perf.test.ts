import { describe, expect, it } from 'vitest';
import { diffRuns } from '../src/index.js';
import { agent, llm, makeRun, tool, type StepSpec } from './fixtures.js';

/** Median wall time of `fn` over `runs` runs, after one warm-up. */
function time<T>(fn: () => T, runs = 5): { ms: number; result: T } {
  let result = fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[Math.floor(samples.length / 2)]!, result };
}

const turn = (i: number, variant = ''): StepSpec[] => [
  llm('claude-sonnet-4-5', { turn: i, history: `context for turn ${i}` }, { tool_use: i % 3 ? 'web_search' : 'calculator' }),
  i % 3 ? tool('web_search', { query: `query ${i}` }, `results for ${i}${variant}`) : tool('calculator', { expr: `${i}*2` }, `${i * 2}`),
];

/** ~2,000 spans: an orchestrator with 40 sub-agents of 25 turns (llm + tool) each. */
function nestedRun(edit: boolean): StepSpec {
  return agent('orchestrator', Array.from({ length: 40 }, (_, a) => {
    let turns = Array.from({ length: 25 }, (_, t) => turn(a * 100 + t, edit && t === 7 ? ' (stale)' : '')).flat();
    if (edit && a % 10 === 3) turns = turns.filter((_, k) => k !== 10); // drop a step
    if (edit && a % 10 === 5) turns.splice(20, 0, tool('notes', { note: a }, 'saved')); // add a step
    return agent(`researcher-${a}`, turns);
  }));
}

/** 2,000 spans as one flat sibling list: the worst case for sibling alignment (n·m = 4M). */
function flatRun(edit: boolean): StepSpec {
  let steps = Array.from({ length: 1000 }, (_, i) => turn(i, edit && i % 97 === 0 ? ' (changed)' : '')).flat();
  if (edit) {
    steps = steps.filter((_, k) => k % 211 !== 50);
    steps.splice(1500, 0, tool('notes', { note: 1 }, 'saved'));
  }
  return agent('flat', steps);
}

const log = (label: string, ms: number, spans: number, d: ReturnType<typeof diffRuns>) =>
  console.log(
    `[perf] ${label.padEnd(36)} ${String(spans).padStart(5)} spans  ${ms.toFixed(1).padStart(7)} ms  ` +
      `mode=${d.alignment.mode} cells=${d.alignment.cells.toLocaleString('en-US')} rows=${d.rows.length}`,
  );

describe('performance', () => {
  it('nested 2,000-span runs diff in well under a second (exact DP per sibling list)', () => {
    const a = makeRun(nestedRun(false), 'a');
    const b = makeRun(nestedRun(true), 'b');
    expect(a.length).toBeGreaterThanOrEqual(2000);
    const { ms, result } = time(() => diffRuns(a, b));
    log('nested, exact', ms, a.length, result);
    expect(result.alignment.mode).toBe('exact');
    expect(result.rows.filter((r) => r.status === 'removed')).toHaveLength(4);
    expect(result.rows.filter((r) => r.status === 'added')).toHaveLength(4);
    expect(ms).toBeLessThan(1000);
  });

  it('flat 2,000-sibling runs switch to the banded fallback and stay fast', () => {
    const a = makeRun(flatRun(false), 'a');
    const b = makeRun(flatRun(true), 'b');
    const banded = time(() => diffRuns(a, b));
    log('flat, banded (default)', banded.ms, a.length, banded.result);
    const exact = time(() => diffRuns(a, b, { maxCells: Infinity }), 3);
    log('flat, exact (maxCells: Infinity)', exact.ms, a.length, exact.result);

    expect(banded.result.alignment.mode).toBe('banded');
    expect(exact.result.alignment.mode).toBe('exact');
    // On realistic edits the band loses nothing: same rows, same statuses.
    expect(banded.result.rows.map((r) => r.status)).toEqual(exact.result.rows.map((r) => r.status));
    expect(banded.result.alignment.cells).toBeLessThan(exact.result.alignment.cells / 4);
    expect(banded.ms).toBeLessThan(1000);
  });

  it('identical 2,000-span runs are cheap (fast path for unchanged subtrees)', () => {
    const a = makeRun(nestedRun(false), 'a');
    const b = makeRun(nestedRun(false), 'b');
    const { ms, result } = time(() => diffRuns(a, b));
    log('nested, identical', ms, a.length, result);
    expect(result.rows.every((r) => r.status === 'same')).toBe(true);
    expect(ms).toBeLessThan(500);
  });
});
