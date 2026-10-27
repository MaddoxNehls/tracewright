/**
 * Weighted global sequence alignment (Needleman–Wunsch / weighted edit distance) with an
 * optional band. Generic: callers supply the costs, so the same routine aligns sibling spans
 * (diff.ts) and the unit tests can drive it with plain strings.
 */

export interface AlignmentCosts {
  /** Length of sequence A. */
  n: number;
  /** Length of sequence B. */
  m: number;
  /** Cost of leaving A[i] unmatched (a deletion). Must be > 0. */
  gapA(i: number): number;
  /** Cost of leaving B[j] unmatched (an insertion). Must be > 0. */
  gapB(j: number): number;
  /** Cost of aligning A[i] with B[j]; `Infinity` forbids it. */
  pair(i: number, j: number): number;
}

export interface AlignOptions {
  /** Use the exact O(n·m) table while (n+1)·(m+1) ≤ maxCells. Default 1,000,000. */
  maxCells?: number;
  /** Band half-width in banded mode. Default 100. */
  bandRadius?: number;
}

/** `[i, j]` aligned pair; `[i, -1]` deletion of A[i]; `[-1, j]` insertion of B[j]. */
export type AlignedPair = readonly [number, number];

export interface AlignmentResult {
  pairs: AlignedPair[];
  /** Total cost of the alignment found (optimal in exact mode). */
  cost: number;
  /** DP cells evaluated. */
  cells: number;
  mode: 'exact' | 'banded';
}

export const DEFAULT_MAX_CELLS = 1_000_000;
export const DEFAULT_BAND_RADIUS = 100;

const DIAG = 1;
const UP = 2; // consume A[i-1]: deletion
const LEFT = 3; // consume B[j-1]: insertion
const EPS = 1e-9;

/**
 * Align A and B minimizing Σ pair costs + Σ gap costs.
 *
 * Exact mode fills the full (n+1)×(m+1) table: O(n·m) time and memory.
 *
 * Banded mode (used when the table would exceed `maxCells`) only fills, in row i, the columns
 * within `bandRadius` of the line from (0,0) to (n,m), widened so consecutive rows always
 * overlap. That is O((n + m) + n·bandRadius) time and memory. The result is always a valid
 * alignment, and it is optimal whenever some optimal path stays inside the band, which holds
 * for runs that differ by local edits. A large reorder can leave the band, and then the
 * result has more gaps than necessary but is still correct as a diff.
 *
 * Ties prefer pairing over gaps. Inside each run of consecutive gaps, deletions are emitted
 * before insertions (cost-neutral) so the output reads like a conventional diff.
 */
export function alignSequences(costs: AlignmentCosts, options: AlignOptions = {}): AlignmentResult {
  const { n, m } = costs;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const radius = Math.max(1, Math.floor(options.bandRadius ?? DEFAULT_BAND_RADIUS));

  const gapA = new Float64Array(n);
  const gapB = new Float64Array(m);
  for (let i = 0; i < n; i++) gapA[i] = costs.gapA(i);
  for (let j = 0; j < m; j++) gapB[j] = costs.gapB(j);

  if (n === 0 || m === 0) {
    const pairs: AlignedPair[] = [];
    let cost = 0;
    for (let i = 0; i < n; i++) (pairs.push([i, -1]), (cost += gapA[i]!));
    for (let j = 0; j < m; j++) (pairs.push([-1, j]), (cost += gapB[j]!));
    return { pairs, cost, cells: 0, mode: 'exact' };
  }

  const banded = (n + 1) * (m + 1) > maxCells;
  const lo = new Int32Array(n + 1);
  const hi = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    if (!banded) {
      lo[i] = 0;
      hi[i] = m;
    } else {
      // Column range around the (0,0)→(n,m) diagonal, spanning to the next row's center so
      // that row i always overlaps row i−1 even when m ≫ n.
      const from = Math.floor((i * m) / n);
      const to = i < n ? Math.ceil(((i + 1) * m) / n) : m;
      lo[i] = Math.max(0, from - radius);
      hi[i] = Math.min(m, to + radius);
    }
  }
  const offset = new Int32Array(n + 2);
  for (let i = 0; i <= n; i++) offset[i + 1] = offset[i]! + (hi[i]! - lo[i]! + 1);
  const cells = offset[n + 1]!;

  const score = new Float64Array(cells);
  const back = new Uint8Array(cells);

  const at = (i: number, j: number): number =>
    j < lo[i]! || j > hi[i]! ? Infinity : score[offset[i]! + j - lo[i]!]!;

  for (let i = 0; i <= n; i++) {
    const rowLo = lo[i]!;
    const rowHi = hi[i]!;
    const base = offset[i]! - rowLo;
    for (let j = rowLo; j <= rowHi; j++) {
      if (i === 0 && j === 0) {
        score[base] = 0;
        continue;
      }
      let best = Infinity;
      let dir = 0;
      if (i > 0 && j > 0) {
        const prev = at(i - 1, j - 1);
        if (prev < Infinity) {
          const p = costs.pair(i - 1, j - 1);
          if (p < Infinity) {
            best = prev + p;
            dir = DIAG;
          }
        }
      }
      if (i > 0) {
        const v = at(i - 1, j) + gapA[i - 1]!;
        if (v < best - EPS) {
          best = v;
          dir = UP;
        }
      }
      if (j > rowLo) {
        const v = score[base + j - 1]! + gapB[j - 1]!;
        if (v < best - EPS) {
          best = v;
          dir = LEFT;
        }
      }
      score[base + j] = best;
      back[base + j] = dir;
    }
  }

  // Trace back from (n, m).
  const reversed: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = back[offset[i]! + j - lo[i]!]!;
    if (dir === DIAG) reversed.push([--i, --j]);
    else if (dir === UP) reversed.push([--i, -1]);
    else if (dir === LEFT) reversed.push([-1, --j]);
    else throw new Error(`alignSequences: unreachable cell (${i}, ${j})`); // band invariant broken
  }
  reversed.reverse();

  return { pairs: deletionsFirst(reversed), cost: score[cells - 1]!, cells, mode: banded ? 'banded' : 'exact' };
}

/** Within each maximal run of gaps, move deletions ahead of insertions (stable). */
function deletionsFirst(pairs: AlignedPair[]): AlignedPair[] {
  const out: AlignedPair[] = [];
  let k = 0;
  while (k < pairs.length) {
    const p = pairs[k]!;
    if (p[0] >= 0 && p[1] >= 0) {
      out.push(p);
      k++;
      continue;
    }
    let end = k;
    while (end < pairs.length && (pairs[end]![0] < 0 || pairs[end]![1] < 0)) end++;
    for (let t = k; t < end; t++) if (pairs[t]![1] < 0) out.push(pairs[t]!);
    for (let t = k; t < end; t++) if (pairs[t]![0] < 0) out.push(pairs[t]!);
    k = end;
  }
  return out;
}
