import { describe, expect, it } from 'vitest';
import { diffRuns, type DiffRow, type RunDiff } from '../src/index.js';
import { agent, llm, makeRun, researchRun, shuffle, tool } from './fixtures.js';

const statuses = (d: RunDiff) => d.rows.map((r) => r.status);
const count = (d: RunDiff, s: DiffRow['status']) => d.rows.filter((r) => r.status === s).length;
const fields = (r: DiffRow) => r.changes.filter((c) => c.significant).map((c) => c.field);

describe('diffRuns: scenarios', () => {
  it('identical runs (different ids, shuffled storage order) are all same', () => {
    const d = diffRuns(makeRun(researchRun(), 'a'), shuffle(makeRun(researchRun(), 'b'), 3));
    expect(statuses(d)).toEqual(Array(6).fill('same'));
    expect(d.firstDivergence).toBeNull();
    expect(d.rows.map((r) => r.depth)).toEqual([0, 1, 1, 1, 1, 1]);
    expect(d.summary.delta).toMatchObject({ costUsd: 0, totalTokens: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 });
    expect(d.summary.statusChanged).toBe(false);
  });

  it('a model swap aligns llm to llm and reports a model modification, not delete+insert', () => {
    const left = makeRun(researchRun(), 'a');
    const right = makeRun(researchRun({ model: 'gpt-4o' }), 'b');
    for (const s of right) if (s.kind === 'llm') s.attributes!['tracewright.cost_usd'] = 0.0002;
    const d = diffRuns(left, right);

    expect(count(d, 'added') + count(d, 'removed')).toBe(0);
    const llmRows = d.rows.filter((r) => r.left?.kind === 'llm');
    expect(llmRows).toHaveLength(3);
    for (const row of llmRows) {
      expect(row.status).toBe('modified');
      const model = row.changes.find((c) => c.field === 'model')!;
      expect(model).toMatchObject({ left: 'claude-sonnet-4-5', right: 'gpt-4o', significant: true });
      expect(row.changes.find((c) => c.field === 'cost')).toMatchObject({ delta: -0.0008, significant: true });
    }
    expect(d.rows[0]!.status).toBe('same');
    expect(d.firstDivergence).toMatchObject({ rowIndex: 1, phase: 'enter' });
    expect(d.firstDivergence!.reasons).toContain('model');
    expect(d.summary.delta.costUsd).toBeCloseTo(-0.0024, 10);
    expect(d.summary.delta.llmCalls).toBe(0);
  });

  it('an extra tool call inserted mid-run is a single added row in the right place', () => {
    const extra = tool('web_search', { query: 'world population' }, '8.1 billion');
    const d = diffRuns(makeRun(researchRun(), 'a'), makeRun(researchRun({ extra: [extra] }), 'b'));
    // The root itself is unchanged (+51ms is under the latency threshold), but it is
    // flagged so a UI can highlight the subtree that contains the change.
    expect(statuses(d)).toEqual(['same', 'same', 'same', 'same', 'same', 'added', 'same']);
    expect(d.rows[0]!.descendantsChanged).toBe(true);
    expect(d.rows[1]!.descendantsChanged).toBe(false);
    expect(d.rows[5]).toMatchObject({ status: 'added', depth: 1, right: { name: 'web_search' } });
    expect(d.rows[5]!.left).toBeUndefined();
    expect(d.firstDivergence).toMatchObject({ rowIndex: 5, phase: 'enter', reasons: ['added'] });
    expect(d.summary.delta.toolCalls).toBe(1);
  });

  it('a removed step is a single removed row', () => {
    const left = makeRun(researchRun(), 'a');
    const right = makeRun(researchRun(), 'b').filter((s) => s.name !== 'calculator');
    const d = diffRuns(left, right);
    expect(count(d, 'removed')).toBe(1);
    expect(count(d, 'added')).toBe(0);
    expect(d.rows[4]).toMatchObject({ status: 'removed', left: { name: 'calculator' } });
    expect(d.firstDivergence).toMatchObject({ rowIndex: 4, reasons: ['removed'] });
    expect(d.summary.delta.toolCalls).toBe(-1);
  });

  it('a reordered tool sequence keeps one match and reports the other as a move', () => {
    const search = tool('web_search', { query: 'France' }, '68.4M');
    const calc = tool('calculator', { expr: '1+1' }, '2');
    const d = diffRuns(makeRun(agent('root', [search, calc]), 'a'), makeRun(agent('root', [calc, search]), 'b'));
    expect(d.rows).toHaveLength(4);
    expect(count(d, 'same')).toBe(2); // root + the step that kept its place
    expect(count(d, 'removed')).toBe(1);
    expect(count(d, 'added')).toBe(1);
    const removed = d.rows.findIndex((r) => r.status === 'removed');
    const added = d.rows.findIndex((r) => r.status === 'added');
    expect(d.rows[removed]!.left!.name).toBe(d.rows[added]!.right!.name);
    expect(d.rows[removed]!.movedTo).toBe(added);
    expect(d.rows[added]!.movedFrom).toBe(removed);
  });

  it('error vs success: status, error and output changes; divergence on exit', () => {
    const failing = researchRun();
    failing.children![1] = tool('web_search', { query: 'population of France' }, null, {
      error: { type: 'Timeout', message: 'search timed out after 30s' },
    });
    failing.status = 'error';
    failing.error = { type: 'AgentError', message: 'tool failed' };
    const d = diffRuns(makeRun(researchRun(), 'a'), makeRun(failing, 'b'));
    const row = d.rows[2]!;
    expect(row.status).toBe('modified');
    expect(fields(row)).toEqual(expect.arrayContaining(['status', 'error', 'output']));
    expect(row.changes.find((c) => c.field === 'status')).toMatchObject({ left: 'ok', right: 'error' });
    expect(d.firstDivergence).toMatchObject({ rowIndex: 2, phase: 'exit' });
    expect(d.summary).toMatchObject({ statusChanged: true, left: { status: 'ok' }, right: { status: 'error' } });
  });

  it('nested agents: aligns inside sub-agents and finds the first divergence in a leaf, not the root', () => {
    const build = (plan: string, withCalc: boolean, answer: string) =>
      agent('orchestrator', [
        agent('planner', [llm('claude-sonnet-4-5', 'plan it', plan)]),
        agent('worker', [
          llm('claude-sonnet-4-5', 'work', 'call tools'),
          tool('web_search', 'q', 'r'),
          ...(withCalc ? [tool('calculator', '1+1', '2')] : []),
        ]),
      ], { input: 'task', output: answer });
    const d = diffRuns(makeRun(build('step 1, step 2', true, 'A'), 'a'), makeRun(build('step 1 only', false, 'B'), 'b'));

    expect(d.rows.map((r) => [r.depth, r.left?.name ?? r.right!.name, r.status])).toEqual([
      [0, 'orchestrator', 'modified'],
      [1, 'planner', 'same'],
      [2, 'chat claude-sonnet-4-5', 'modified'],
      [1, 'worker', 'same'],
      [2, 'chat claude-sonnet-4-5', 'same'],
      [2, 'web_search', 'same'],
      [2, 'calculator', 'removed'],
    ]);
    // Root output differs too, but its output happens *after* its children: the Euler-tour
    // order puts the planner's llm output first.
    expect(d.firstDivergence).toMatchObject({ rowIndex: 2, phase: 'exit', reasons: ['output'] });
    expect(d.rows[6]!.parentIndex).toBe(3);
    expect(d.rows.map((r) => r.descendantsChanged)).toEqual([true, true, false, true, false, false, false]);
  });

  it('orphans: a run whose root has not arrived yet still aligns under a placeholder', () => {
    const left = makeRun(researchRun(), 'a');
    const right = makeRun(researchRun(), 'b').filter((s) => s.parent_span_id !== null);
    const d = diffRuns(left, right);
    expect(d.rows[0]).toMatchObject({ status: 'modified', right: { placeholder: true } });
    expect(d.rows[0]!.changes.map((c) => c.field)).toEqual(['presence']);
    expect(statuses(d).slice(1)).toEqual(Array(5).fill('same'));
    expect(d.rows.slice(1).every((r) => r.right!.orphan)).toBe(true);
    // A missing span is a recording gap, not a behavior change.
    expect(d.firstDivergence).toBeNull();
    expect(d.summary.right.spans).toBe(5);
  });

  it('treats latency/cost/token jitter under the thresholds as noise', () => {
    const right = makeRun(researchRun(), 'b');
    const l = right.find((s) => s.kind === 'llm')!;
    l.attributes!['gen_ai.usage.output_tokens'] = 22; // +2 tokens
    l.attributes!['tracewright.cost_usd'] = 0.00101;
    const d = diffRuns(makeRun(researchRun(), 'a'), right);
    expect(d.rows[1]!.status).toBe('same');
    expect(d.rows[1]!.changes.map((c) => [c.field, c.significant])).toEqual([
      ['tokens', false],
      ['cost', false],
    ]);
    expect(d.firstDivergence).toBeNull();

    // ...but a tighter threshold turns the same delta into a divergence.
    const strict = diffRuns(makeRun(researchRun(), 'a'), right, { thresholds: { tokens: { abs: 1, rel: 0 } } });
    expect(strict.firstDivergence).toMatchObject({ rowIndex: 1, phase: 'exit', reasons: ['tokens'] });
  });

  it('reports token deltas with an input/output breakdown and latency deltas in ms', () => {
    const right = makeRun(researchRun(), 'b');
    const l = right.find((s) => s.kind === 'llm')!;
    l.attributes!['gen_ai.usage.input_tokens'] = 400;
    l.end_time = l.end_time.replace('T12:00:00.8', 'T12:00:05.8');
    const d = diffRuns(makeRun(researchRun(), 'a'), right);
    const tokens = d.rows[1]!.changes.find((c) => c.field === 'tokens')!;
    expect(tokens).toMatchObject({
      left: { input: 100, output: 20, total: 120 },
      right: { input: 400, output: 20, total: 420 },
      delta: 300,
      significant: true,
    });
    expect(d.rows[1]!.changes.find((c) => c.field === 'latency')).toMatchObject({ delta: 5000, significant: true });
  });

  it('handles empty runs', () => {
    expect(diffRuns([], []).rows).toEqual([]);
    const d = diffRuns([], makeRun(researchRun()));
    expect(statuses(d)).toEqual(Array(6).fill('added'));
    expect(d.firstDivergence).toMatchObject({ rowIndex: 0, reasons: ['added'] });
  });
});
