import { formatPayload } from './features.js';
import type { DiffRow } from './types.js';

export type TextGranularity = 'line' | 'word' | 'char';
export type DiffOpKind = 'equal' | 'insert' | 'delete';

/** A run of consecutive tokens with the same op. Concatenating equal+delete gives the old text. */
export interface DiffOp {
  op: DiffOpKind;
  text: string;
}

export interface HunkLine {
  op: DiffOpKind;
  /** The token; for line granularity, without its trailing newline. */
  text: string;
  /** 1-based token (line) number in the old text, for equal and delete. */
  oldLine?: number;
  /** 1-based token (line) number in the new text, for equal and insert. */
  newLine?: number;
}

/** A unified-diff style hunk: changed tokens plus `context` unchanged tokens around them. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface TextDiff {
  granularity: TextGranularity;
  /** The whole edit script, coalesced. Use it for inline (word/char) rendering. */
  ops: DiffOp[];
  /** Changes grouped with context. Use it for side-by-side or unified (line) rendering. */
  hunks: Hunk[];
  /** Tokens inserted / deleted. */
  insertions: number;
  deletions: number;
  identical: boolean;
  /** False when the edit distance exceeded `maxEditDistance` and the middle was replaced wholesale. */
  exact: boolean;
}

export interface TextDiffOptions {
  /** Default 'line'. */
  granularity?: TextGranularity;
  /** Unchanged tokens kept around each change in `hunks`. Default 3. */
  context?: number;
  /**
   * Give up on a minimal script past this many edits (D) and report the differing middle as
   * one deletion plus one insertion. Bounds the time to O((N+M)·D) and the memory to O(D²).
   * Default 2000.
   */
  maxEditDistance?: number;
}

const WORD_TOKENS = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const LINE_TOKENS = /[^\n]*\n|[^\n]+$/g;

function tokenize(text: string, granularity: TextGranularity): string[] {
  if (granularity === 'char') return Array.from(text);
  return text.match(granularity === 'word' ? WORD_TOKENS : LINE_TOKENS) ?? [];
}

interface Edit {
  op: DiffOpKind;
  /** Token index in the old (delete/equal) or new (insert) sequence. */
  a: number;
  b: number;
}

/**
 * Myers' O((N+M)·D) greedy diff ("An O(ND) Difference Algorithm and Its Variations", 1986)
 * over interned token ids. It stores one slice of the V array per edit step for the
 * traceback, which takes O(D²) memory. Returns null when D exceeds maxD.
 */
function myers(A: Int32Array, B: Int32Array, maxD: number): Edit[] | null {
  const N = A.length;
  const M = B.length;
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V[k] for k in [-d-1, d+1], before step d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1]! < V[off + k + 1]!) ? V[off + k + 1]! : V[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) (x++, y++);
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, d, N, M);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], D: number, N: number, M: number): Edit[] {
  const edits: Edit[] = [];
  let x = N;
  let y = M;
  for (let d = D; d >= 0; d--) {
    const v = trace[d]!;
    const get = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) edits.push({ op: 'equal', a: --x, b: --y });
    if (d > 0) {
      if (x === prevX) edits.push({ op: 'insert', a: x, b: prevY });
      else edits.push({ op: 'delete', a: prevX, b: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

/** Line-, word- or character-level diff of two strings. */
export function diffText(oldText: string, newText: string, options: TextDiffOptions = {}): TextDiff {
  const granularity = options.granularity ?? 'line';
  const context = Math.max(0, options.context ?? 3);
  const maxD = Math.max(1, options.maxEditDistance ?? 2000);

  const a = tokenize(oldText, granularity);
  const b = tokenize(newText, granularity);

  // Intern tokens so the inner loop compares ints, not strings.
  const ids = new Map<string, number>();
  const intern = (t: string) => {
    let id = ids.get(t);
    if (id === undefined) ids.set(t, (id = ids.size));
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);

  // Common prefix/suffix: free and usually most of the text.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const core = myers(A.subarray(pre, A.length - suf), B.subarray(pre, B.length - suf), maxD);
  const exact = core !== null;
  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ op: 'equal', a: i, b: i });
  if (core) {
    for (const e of core) edits.push({ op: e.op, a: e.a + pre, b: e.b + pre });
  } else {
    for (let i = pre; i < A.length - suf; i++) edits.push({ op: 'delete', a: i, b: -1 });
    for (let j = pre; j < B.length - suf; j++) edits.push({ op: 'insert', a: -1, b: j });
  }
  for (let i = suf; i > 0; i--) edits.push({ op: 'equal', a: A.length - i, b: B.length - i });

  const ordered = deletesFirst(edits);
  const text = (e: Edit) => (e.op === 'insert' ? b[e.b]! : a[e.a]!);

  const ops: DiffOp[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const e of ordered) {
    if (e.op === 'insert') insertions++;
    if (e.op === 'delete') deletions++;
    const last = ops[ops.length - 1];
    if (last && last.op === e.op) last.text += text(e);
    else ops.push({ op: e.op, text: text(e) });
  }

  return {
    granularity,
    ops,
    hunks: buildHunks(ordered, text, context, granularity),
    insertions,
    deletions,
    identical: insertions === 0 && deletions === 0,
    exact,
  };
}

/** Within each run of changes, list deletions before insertions (conventional diff order). */
function deletesFirst(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  let k = 0;
  while (k < edits.length) {
    if (edits[k]!.op === 'equal') {
      out.push(edits[k++]!);
      continue;
    }
    let end = k;
    while (end < edits.length && edits[end]!.op !== 'equal') end++;
    for (let t = k; t < end; t++) if (edits[t]!.op === 'delete') out.push(edits[t]!);
    for (let t = k; t < end; t++) if (edits[t]!.op === 'insert') out.push(edits[t]!);
    k = end;
  }
  return out;
}

function buildHunks(edits: Edit[], text: (e: Edit) => string, context: number, granularity: TextGranularity): Hunk[] {
  const ranges: [number, number][] = [];
  edits.forEach((e, k) => {
    if (e.op === 'equal') return;
    const start = Math.max(0, k - context);
    const end = Math.min(edits.length, k + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });

  const display = (s: string) => (granularity === 'line' && s.endsWith('\n') ? s.slice(0, -1) : s);
  return ranges.map(([start, end]) => {
    // Tokens of each side before the hunk.
    let oldBefore = 0;
    let newBefore = 0;
    for (let k = 0; k < start; k++) {
      if (edits[k]!.op !== 'insert') oldBefore++;
      if (edits[k]!.op !== 'delete') newBefore++;
    }
    let oldLine = oldBefore;
    let newLine = newBefore;
    const lines: HunkLine[] = [];
    for (let k = start; k < end; k++) {
      const e = edits[k]!;
      const line: HunkLine = { op: e.op, text: display(text(e)) };
      if (e.op !== 'insert') line.oldLine = ++oldLine;
      if (e.op !== 'delete') line.newLine = ++newLine;
      lines.push(line);
    }
    const oldLines = oldLine - oldBefore;
    const newLines = newLine - newBefore;
    // Unified-diff convention: an empty side points at the line before the hunk.
    return {
      oldStart: oldLines ? oldBefore + 1 : oldBefore,
      oldLines,
      newStart: newLines ? newBefore + 1 : newBefore,
      newLines,
      lines,
    };
  });
}

/**
 * Text diff of a row's input or output, computed on demand. The rows only flag that a payload
 * changed, so this cost is paid only for rows the user opens. Payloads go through
 * `formatPayload` (strings verbatim, JSON with sorted keys).
 */
export function diffPayload(row: DiffRow, field: 'input' | 'output', options?: TextDiffOptions): TextDiff {
  return diffText(formatPayload(row.left?.span[field]), formatPayload(row.right?.span[field]), options);
}
