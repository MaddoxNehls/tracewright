import type { Span, SpanKind, SpanNode, SpanRef, StepSignature, TokenUsage } from './types.js';

// ---------------------------------------------------------------------------------------------
// Attribute access
// ---------------------------------------------------------------------------------------------

const attr = (span: Span, key: string): unknown => span.attributes?.[key];

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The model that served the call: response model, else request model, else the DB column. */
export function spanModel(span: Span): string | null {
  return str(attr(span, 'gen_ai.response.model')) ?? str(attr(span, 'gen_ai.request.model')) ?? str(span.model);
}

export function spanTokens(span: Span): TokenUsage {
  const input = num(span.input_tokens) ?? num(attr(span, 'gen_ai.usage.input_tokens'));
  const output = num(span.output_tokens) ?? num(attr(span, 'gen_ai.usage.output_tokens'));
  return { input, output, total: input === null && output === null ? null : (input ?? 0) + (output ?? 0) };
}

export function spanCost(span: Span): number | null {
  return num(span.cost_usd) ?? num(attr(span, 'tracewright.cost_usd'));
}

// ---------------------------------------------------------------------------------------------
// Step signature
// ---------------------------------------------------------------------------------------------

const VERSION_TOKEN = /^(\d+(\.\d+)*|v\d+(\.\d+)*|\d{8}|latest|preview|exp)$/;

/**
 * Collapse a model id to its family by dropping the provider prefix and version-like tokens:
 * `claude-sonnet-4-5-20250929` and `claude-3-5-sonnet-20241022` → `claude-sonnet`,
 * `anthropic/claude-haiku-4.5` → `claude-haiku`, `gpt-4o-mini` → `gpt-4o-mini`.
 * It is a heuristic, and it only affects the alignment score, never correctness: llm steps
 * from different families still align, at a lower similarity.
 */
export function modelFamily(model: string | null | undefined): string | null {
  if (!model) return null;
  const base = model.toLowerCase().split('/').pop()!;
  const kept = base.split(/[-_@:]/).filter((t) => t !== '' && !VERSION_TOKEN.test(t));
  return kept.length ? kept.join('-') : base;
}

/**
 * The SDKs name llm spans `chat {model}`. Drop the model id(s) from the name, or a model swap
 * would change the step's identity and the swap would show as a delete plus an insert.
 */
function llmLabel(span: Span): string {
  let label = span.name;
  const models = [str(attr(span, 'gen_ai.request.model')), str(attr(span, 'gen_ai.response.model')), str(span.model)];
  for (const m of models.filter((x): x is string => x !== null).sort((a, b) => b.length - a.length)) {
    label = label.split(m).join(' ');
  }
  label = label.replace(/\s+/g, ' ').trim();
  return label || 'llm';
}

export function spanSignature(span: Span): StepSignature {
  const kind: SpanKind = span.kind;
  const tool = kind === 'tool' ? (str(attr(span, 'gen_ai.tool.name')) ?? span.name) : null;
  const label = kind === 'llm' ? llmLabel(span) : span.name;
  const family = kind === 'llm' ? modelFamily(spanModel(span)) : null;
  const compatKey = `${kind}:${label}${tool !== null ? `#${tool}` : ''}`;
  return { kind, label, tool, family, compatKey, key: family ? `${compatKey}@${family}` : compatKey };
}

// ---------------------------------------------------------------------------------------------
// Payload canonicalization, hashing, similarity sketches
// ---------------------------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/**
 * Canonical text of an input/output payload: strings verbatim (so prose diffs well), other
 * JSON pretty-printed with sorted keys (so key order never counts as a change), null → ''.
 */
export function formatPayload(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(sortKeys(value), null, 2) ?? '';
}

/** 32-bit FNV-1a. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export const SKETCH_WORDS = 8; // 256 bits

const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * A 256-bit set sketch of the payload's words: each word sets one bit. Jaccard similarity of
 * two sketches, |a∧b| / |a∨b|, estimates word-set overlap in O(1). The DP compares up to
 * millions of pairs, so it cannot afford a real text diff per pair.
 */
export function sketch(text: string): Uint32Array {
  const bits = new Uint32Array(SKETCH_WORDS);
  for (const m of text.matchAll(WORD)) {
    const h = fnv1a(m[0]) & 255;
    bits[h >>> 5]! |= 1 << (h & 31);
  }
  return bits;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export function jaccard(a: Uint32Array, b: Uint32Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < SKETCH_WORDS; i++) {
    inter += popcount(a[i]! & b[i]!);
    union += popcount(a[i]! | b[i]!);
  }
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------------------------
// Per-node features, computed once per node before alignment
// ---------------------------------------------------------------------------------------------

export interface NodeFeatures {
  node: SpanNode;
  sig: StepSignature;
  /** Interned compatKey: an int compare in the DP inner loop. */
  compatId: number;
  model: string | null;
  inputText: string;
  outputText: string;
  inputHash: number;
  outputHash: number;
  inputSketch: Uint32Array;
  outputSketch: Uint32Array;
  errorText: string;
  /** Node count of the subtree: the cost of deleting or inserting it. */
  weight: number;
  /** Hash of the entire subtree (signature, model, payloads, status, children). */
  subtreeHash: number;
  ref: SpanRef;
}

const durationMs = (n: SpanNode) => Number(n.endNs - n.startNs) / 1e6;

/**
 * Compute features for every node of a tree, children before parents. `interner` is shared
 * by both runs so equal compat keys get equal ids.
 */
export function computeFeatures(nodes: readonly SpanNode[], interner: Map<string, number>): Map<SpanNode, NodeFeatures> {
  const out = new Map<SpanNode, NodeFeatures>();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const { span } = node;
    const sig: StepSignature = node.placeholder
      ? { kind: 'custom', label: '(missing span)', tool: null, family: null, compatKey: '?missing', key: '?missing' }
      : spanSignature(span);
    let compatId = interner.get(sig.compatKey);
    if (compatId === undefined) interner.set(sig.compatKey, (compatId = interner.size));
    const model = spanModel(span);
    const inputText = formatPayload(span.input);
    const outputText = formatPayload(span.output);
    const errorText = span.error ? `${span.error.type}: ${span.error.message}` : '';
    const inputHash = fnv1a(inputText);
    const outputHash = fnv1a(outputText);

    let weight = 1;
    let h = fnv1a(`${sig.key}\u0000${model ?? ''}\u0000${span.status}\u0000${errorText}`);
    h = fnv1a(String(inputHash), h);
    h = fnv1a(String(outputHash), h);
    for (const c of node.children) {
      const cf = out.get(c)!;
      weight += cf.weight;
      h = fnv1a(String(cf.subtreeHash), h);
    }

    const tokens = spanTokens(span);
    out.set(node, {
      node,
      sig,
      compatId,
      model,
      inputText,
      outputText,
      inputHash,
      outputHash,
      inputSketch: sketch(inputText),
      outputSketch: sketch(outputText),
      errorText,
      weight,
      subtreeHash: h,
      ref: {
        spanId: span.span_id,
        parentSpanId: span.parent_span_id,
        name: span.name,
        kind: sig.kind,
        signature: sig.key,
        model,
        status: span.status,
        error: span.error,
        startTime: span.start_time,
        endTime: span.end_time,
        durationMs: durationMs(node),
        tokens,
        costUsd: spanCost(span),
        orphan: node.orphan,
        placeholder: node.placeholder,
        index: node.index,
        span,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------------------------

/** Weights of the similarity score. They sum to 1, so identical steps score exactly 1. */
export const SIMILARITY_WEIGHTS = { signature: 0.4, input: 0.25, output: 0.25, status: 0.1 } as const;

function contentSim(ha: number, hb: number, ta: string, tb: string, sa: Uint32Array, sb: Uint32Array): number {
  // Hash equal: confirm with the text only when it is short, since the hash is 32-bit and a
  // collision costs only alignment quality, never correctness (changes use exact compares).
  if (ha === hb && (ta.length > 64 || ta === tb)) return 1;
  // Capped below 1 so a near-identical payload never ties with an identical one.
  return 0.9 * jaccard(sa, sb);
}

/**
 * Similarity in [0, 1] of two steps, or -1 when they may not be aligned (different
 * compatKey). Placeholders are compatible with anything, at a low score.
 */
export function similarity(a: NodeFeatures, b: NodeFeatures): number {
  const W = SIMILARITY_WEIGHTS;
  if (a.node.placeholder || b.node.placeholder) {
    return a.node.placeholder && b.node.placeholder ? 1 : W.signature * 0.5;
  }
  if (a.compatId !== b.compatId) return -1;
  const sig = a.model === b.model ? 1 : a.sig.family === b.sig.family ? 0.85 : 0.5;
  return (
    W.signature * sig +
    W.input * contentSim(a.inputHash, b.inputHash, a.inputText, b.inputText, a.inputSketch, b.inputSketch) +
    W.output * contentSim(a.outputHash, b.outputHash, a.outputText, b.outputText, a.outputSketch, b.outputSketch) +
    W.status * (a.node.span.status === b.node.span.status ? 1 : 0)
  );
}
