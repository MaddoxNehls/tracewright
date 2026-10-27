import type { Span } from '../src/index.js';

/** A compact, declarative description of a span subtree used to build test runs. */
export interface StepSpec {
  name: string;
  kind: Span['kind'];
  tool?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  status?: 'ok' | 'error';
  error?: { type: string; message: string };
  tokens?: [number, number];
  cost?: number;
  /** Self time in ms, added after the children finish. Defaults to 100. */
  dur?: number;
  children?: StepSpec[];
}

export const agent = (name: string, children: StepSpec[] = [], extra: Partial<StepSpec> = {}): StepSpec => ({
  name,
  kind: 'agent',
  children,
  ...extra,
});

export const llm = (model: string, input: unknown, output: unknown, extra: Partial<StepSpec> = {}): StepSpec => ({
  name: `chat ${model}`,
  kind: 'llm',
  model,
  input,
  output,
  tokens: [100, 20],
  cost: 0.001,
  dur: 800,
  ...extra,
});

export const tool = (name: string, input: unknown, output: unknown, extra: Partial<StepSpec> = {}): StepSpec => ({
  name,
  kind: 'tool',
  tool: name,
  input,
  output,
  dur: 50,
  ...extra,
});

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

function iso(ms: number): string {
  // RFC3339Nano with a fixed 9-digit fraction, the way the Go ingest stores it.
  const whole = Math.floor(ms);
  const d = new Date(whole);
  const frac = String(whole % 1000).padStart(3, '0') + '000000';
  return d.toISOString().slice(0, 19) + '.' + frac + 'Z';
}

/**
 * Turn specs into contract-shaped spans. Siblings run sequentially; a parent ends after its
 * children plus its own `dur`. `prefix` keeps span ids distinct between runs, like real runs.
 */
export function makeRun(roots: StepSpec | StepSpec[], prefix = 'a', traceId = 'f'.repeat(32)): Span[] {
  const spans: Span[] = [];
  let counter = 0;
  const nextId = () => (prefix + (counter++).toString(16)).padStart(16, '0').slice(-16);

  const emit = (spec: StepSpec, parent: string | null, start: number): number => {
    const id = nextId();
    const index = spans.length;
    spans.push(null as unknown as Span); // reserve pre-order slot
    let clock = start + 1;
    for (const child of spec.children ?? []) clock = emit(child, id, clock) + 1;
    const end = clock + (spec.dur ?? 100);
    const attributes: Record<string, unknown> = {};
    if (spec.model) {
      attributes['gen_ai.request.model'] = spec.model;
      attributes['gen_ai.response.model'] = spec.model;
    }
    if (spec.tool) attributes['gen_ai.tool.name'] = spec.tool;
    if (spec.tokens) {
      attributes['gen_ai.usage.input_tokens'] = spec.tokens[0];
      attributes['gen_ai.usage.output_tokens'] = spec.tokens[1];
    }
    if (spec.cost !== undefined) attributes['tracewright.cost_usd'] = spec.cost;
    const status = spec.status ?? (spec.error ? 'error' : 'ok');
    spans[index] = {
      trace_id: traceId,
      span_id: id,
      parent_span_id: parent,
      name: spec.name,
      kind: spec.kind,
      start_time: iso(start),
      end_time: iso(end),
      status,
      error: status === 'error' ? (spec.error ?? { type: 'Error', message: 'failed' }) : null,
      attributes,
      input: spec.input ?? null,
      output: spec.output ?? null,
    };
    return end;
  };

  let clock = BASE;
  for (const root of Array.isArray(roots) ? roots : [roots]) clock = emit(root, null, clock) + 1;
  return spans;
}

/** Fisher-Yates with a seeded PRNG: storage order must never matter. */
export function shuffle<T>(items: T[], seed = 1): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A typical research-agent run used by several scenarios. */
export function researchRun(overrides: { model?: string; extra?: StepSpec[] } = {}): StepSpec {
  const model = overrides.model ?? 'claude-sonnet-4-5';
  return agent('research', [
    llm(model, { q: 'population of France' }, { tool_use: 'search' }),
    tool('web_search', { query: 'population of France' }, 'France has 68.4 million people'),
    llm(model, { q: 'compute share' }, { tool_use: 'calculator' }),
    tool('calculator', { expr: '68.4 / 8100' }, '0.00844'),
    ...(overrides.extra ?? []),
    llm(model, { q: 'final answer' }, 'France is about 0.84% of the world population.'),
  ], { input: 'How big is France?', output: 'About 0.84%.' });
}
