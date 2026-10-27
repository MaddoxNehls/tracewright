# @tracewright/run-diff

Takes two agent runs and answers two questions: **where did they first diverge, and what changed?**

The input is the stored spans of each run, exactly as described in the [wire contract](../../docs/contract.md). The output is a list of aligned rows that a UI can render side by side, plus the first divergence point and summary deltas. The package is ESM with TypeScript types and has no runtime dependencies.

```ts
import { diffRuns, diffPayload } from '@tracewright/run-diff';

const diff = diffRuns(baselineSpans, candidateSpans);

diff.firstDivergence; // { rowIndex: 1, phase: 'enter', reasons: ['model'] }
diff.summary.delta;   // { costUsd: -0.0024, totalTokens: 0, durationMs: 52, llmCalls: 0, toolCalls: 1, ... }
for (const row of diff.rows) {
  row.status;  // 'same' | 'modified' | 'added' | 'removed'
  row.left;    // SpanRef | undefined: run A's side
  row.right;   // SpanRef | undefined: run B's side
  row.depth;   // indentation in the merged tree
  row.changes; // FieldChange[]: model, status, error, input, output, tokens, cost, latency
}
diffPayload(diff.rows[4], 'output', { granularity: 'word' }); // text diff, computed on demand
```

## The algorithm

### 1. Build each run's tree

The spans are linked by `parent_span_id`, and children are sorted by `start_time`. Timestamps are parsed to nanoseconds as `bigint`, because `Date.parse` keeps only milliseconds and agent tool calls can start microseconds apart. The builder also handles malformed and partial runs:

| Situation | Handling |
|---|---|
| Duplicate span (SDK retry) | Collapsed, since ingest is idempotent |
| Several `parent_span_id: null` | Several roots, ordered by start |
| **Orphans** (the parent was never recorded) | Grouped under one synthetic **placeholder** per missing parent id. Ingest notes the root "may come last", so an in-flight run is usually a forest of orphans with the same missing parent. The placeholder can align with the real root on the other side, so everything below it still lines up. |
| Parent cycle | Broken at the earliest span, which becomes an orphan root. No span is ever dropped. |

### 2. Step signatures

A step's identity is **kind + name + tool name (tool spans) + model family (llm spans)**, for example `tool:web_search#web_search` or `llm:chat@claude-sonnet`. Two parts of this matter:

* **The SDKs name llm spans `chat {model}`.** A naive `kind + name` key would turn a model swap into a delete plus an insert. The model id is removed from the name, so the label is `chat`.
* The signature is **split into a hard part and a soft part.** `compatKey = kind + label + tool` must be equal for two steps to align at all. The model family only lowers the similarity score: same model 1.0, same family 0.85 (`sonnet-4` → `sonnet-4.5`), different family 0.5 (`claude` → `gpt`). So a model swap still aligns llm with llm and is reported as a `model` **modification**.

`modelFamily` removes the provider prefix and any version or date tokens: `claude-sonnet-4-5-20250929` → `claude-sonnet`, `gpt-4o-mini` → `gpt-4o-mini`.

### 3. Tree-aware alignment

The two top-level lists are aligned first. Then, for every **aligned pair**, the children of the left node are aligned with the children of the right node, recursively. An unaligned node is emitted as `removed`/`added` together with its whole subtree.

Each sibling list is aligned with a weighted global alignment DP (Needleman–Wunsch, or weighted edit distance):

```
D[i][j] = min( D[i-1][j-1] + pair(a_i, b_j),     // align (same / modified)
               D[i-1][j]   + gap(a_i),           // a_i removed
               D[i][j-1]   + gap(b_j) )          // b_j added

gap(x)     = w(x)                         w = subtree size: dropping a big subtree costs more
pair(x, y) = (1 − sim(x, y)) · (w(x) + w(y))     or ∞ if the compatKeys differ
sim(x, y)  = 0.4·signature + 0.25·input + 0.25·output + 0.1·status      ∈ [0, 1]
```

Pairing two compatible steps always costs **strictly less** than removing one and adding the other, because `sim > 0`. So the DP leaves a compatible step unpaired only when that lets better pairs line up. That is exactly the "extra `web_search` inserted between two other `web_search` calls" case. Input/output similarity is 1 for equal payloads (canonical JSON with sorted keys), and otherwise 0.9 × the Jaccard index of 256-bit word-set sketches. A sketch comparison is O(1), which matters because the DP can compare millions of pairs. Ties prefer pairing. Inside each run of gaps, removals are listed before additions.

Fast path: if two sibling lists have identical subtree hashes, they pair one-to-one with no DP. A zero-cost alignment is optimal because every cost is ≥ 0. Identical runs therefore cost O(n).

#### Worked example

Run A: `plan(sonnet) → web_search → answer(sonnet)`. Run B swaps to haiku and adds a calculator call: `plan(haiku) → web_search → calculator → answer(haiku, new text)`. These are the similarity values `diffRuns` computes (−1 = incompatible):

| A \ B | plan (haiku) | web_search | calculator | answer (haiku) |
|---|---|---|---|---|
| plan (sonnet) | **0.80** | −1 | −1 | 0.30 |
| web_search | −1 | **1.00** | −1 | −1 |
| answer (sonnet) | 0.30 | −1 | −1 | **0.55** |

Optimal path cost = 0.4 (plan pair: (1−0.8)·2) + 0 (web_search) + 1 (calculator gap) + 0.9 (answer pair) = **2.3**. Rows:

```
0 same      agent:research          agent:research
1 modified  llm:chat@claude-sonnet  llm:chat@claude-haiku    model          ← first divergence (enter)
2 same      tool:web_search         tool:web_search
3 added     -                       tool:calculator
4 modified  llm:chat@claude-sonnet  llm:chat@claude-haiku    model, output
```

A pure LCS over signatures would give no match between `chat@claude-sonnet` and `chat@claude-haiku`, so it would report 2 removals and 2 additions. If the signature ignored the model, LCS would call row 4 "same".

#### Why this design rather than plain LCS or full tree edit distance

* **vs. plain LCS.** LCS can only say equal or not equal. It cannot say "same step, different model". When there are several candidates with the same signature (three `web_search` calls, one of them new), it cannot pick the one whose *content* matches. It also cannot weigh a 50-span sub-agent more heavily than a single tool call. The weighted DP keeps LCS's O(n·m) cost and adds all three.
* **vs. Zhang–Shasha tree edit distance.** Zhang–Shasha costs O(n²m²) time in the worst case (O(n·m·min(depth, leaves)²) in general). More importantly, its edit model suits traces poorly. "Delete a node and promote its children" would re-parent a sub-agent's tool calls under the orchestrator, and it can map a planner's tool call to a worker's. In an agent run, a step's identity includes its call stack. The top-down (Selkow-style) alignment used here only matches children of matched parents, which is the right constraint and also much cheaper.
* **Trade-offs accepted.**
  * A step that moves *across* parents shows as removed plus added. Within one sibling list the pair is labeled with `movedTo`/`movedFrom`, when the subtrees are identical.
  * Parents are paired on their own fields plus subtree size, before their children are compared. A pair of large but internally different sub-agents is still aligned and then diffed inside, which is usually what you want.

#### Pathological sizes: the banded fallback

When `(n+1)(m+1)` for a sibling list exceeds `maxCells` (default 1,000,000, about 1000 × 1000 siblings and about 9 MB of scratch), the aligner:

1. trims the common prefix and suffix of identical subtrees, then
2. fills only a **band** of ±`bandRadius` cells (default 100) around the (0,0)→(n,m) diagonal. Each row's band is widened so it always overlaps the previous one, which keeps (n,m) reachable even when m ≫ n.

The banded result is always a valid alignment. It is optimal whenever an optimal path stays inside the band, which holds for runs that differ by local edits. The tests compare banded and exact results on randomized near-diagonal inputs and on the flat 2,000-span perf case. A massive reorder can leave the band, and then the diff has extra add/remove rows but stays correct. `diff.alignment.mode` reports whether any list used the band.

### 4. Changes, first divergence, summary

**Changes** are computed per aligned pair. `model`, `status`, `error`, `input` and `output` are *behavior* and always significant. `tokens` (with an input/output breakdown), `cost` and `latency` are *metrics* with `delta` and `ratio`, and are significant only when `|Δ| ≥ abs` **and** `|Δ|/|left| ≥ rel`:

| threshold | abs | rel |
|---|---|---|
| `latencyMs` | 500 | 0.5 |
| `costUsd` | 0.0005 | 0.25 |
| `tokens` | 50 | 0.25 |

A row is `modified` when it has any significant change. Changes under the thresholds are still listed, with `significant: false`, so the UI can show them dimmed. `descendantsChanged` flags rows whose subtree contains a change.

**First divergence** is computed with an Euler tour, not plain pre-order. A span is visited on **enter**, to check whether it was added or removed or its `model`/`input` changed, and again on **exit** after its children, to check `output`/`status`/`error`/significant metrics. This mirrors execution: a parent's input exists before its children run, and its output after. Plain pre-order would blame the root, because its output always changes when anything inside it changes. The Euler tour points at the earliest cause, for example `{ rowIndex: 2, phase: 'exit', reasons: ['output'] }` for a planner's llm call. A placeholder (`presence` change) is a recording gap, not a behavior change, so it never counts as a divergence.

**Summary** gives per-run totals that match the ingest `runs` table semantics (spans, llm/tool calls, tokens, cost, wall time, root status), plus `delta = right − left`, `statusChanged`, and row counts per status.

### 5. Text diff

`diffText(a, b, { granularity: 'line' | 'word' | 'char', context, maxEditDistance })` is Myers' O((N+M)·D) algorithm over interned tokens, after stripping the common prefix and suffix. It returns coalesced `ops` for inline rendering and unified-style `hunks` with line numbers and context. Memory is O(D²). If D exceeds `maxEditDistance` (default 2000), the differing middle becomes one delete plus one insert and the result is marked `exact: false`, so a pathological pair of 256 KB payloads cannot stall the UI. `diffPayload(row, 'input' | 'output')` runs it on demand for one row. Payloads are rendered with `formatPayload`: strings verbatim, JSON pretty-printed with sorted keys.

## Complexity

N, M = span counts. The DP terms are summed over the sibling lists of aligned parents, with n_k and m_k the list lengths.

| Phase | Time | Memory |
|---|---|---|
| Build trees | O(N log N + M log M) | O(N + M) |
| Features (canonical JSON, hashes, sketches) | O(payload bytes) | O(N + M) |
| Alignment, exact | O(Σ n_k·m_k), ≤ O(N·M) for a flat run, far less when nested | O(max n_k·m_k), ≤ 9 B·maxCells |
| Alignment, banded | O(Σ (n_k + m_k)·bandRadius) | same, per list |
| Identical subtrees | O(size) via subtree hashes | — |
| First divergence, summary | O(rows) | O(depth) |
| Text diff (on demand) | O((A+B)·D) | O(D²), D ≤ maxEditDistance |

Recursion depth equals tree depth.

Measured by `test/perf.test.ts` (median of 5, Node 24, Windows laptop):

| Case | Spans | Mode | DP cells | Time |
|---|---|---|---|---|
| Nested: 40 sub-agents × 50 steps; 4 removed, 4 added, 40 modified | 2,041 | exact | 79,715 | **~49 ms** |
| Nested, identical | 2,041 | exact (fast path) | 0 | **~21 ms** |
| Flat: 2,000 siblings; 10 removed, 1 added, 11 modified | 2,001 | banded (default) | 375,495 | **~51 ms** |
| Flat, forced exact (`maxCells: Infinity`) | 2,001 | exact | 3,985,996 | ~287 ms |

On the flat case the band evaluates 10.6× fewer cells and gives the same rows as exact DP.

## API

| Export | Description |
|---|---|
| `diffRuns(left: Span[], right: Span[], options?: DiffOptions): RunDiff` | The run diff. Options: `thresholds`, `maxCells`, `bandRadius`. |
| `diffText(a, b, options?): TextDiff` | Myers diff at line, word or char granularity. |
| `diffPayload(row, 'input' \| 'output', options?): TextDiff` | Text diff of one row's payloads. |
| `formatPayload(value): string` | Canonical text of a payload. |
| `buildTree(spans): RunTree` | The tree builder, also useful for the run-detail view. |
| `spanSignature(span)`, `modelFamily(model)` | Signature internals. |
| `findFirstDivergence(rows)` | Euler-tour divergence over any row list. |
| `alignSequences(costs, options?)` | The generic weighted, banded aligner. |
| `parseTimestamp`, `spanModel`, `spanTokens`, `spanCost` | Span field helpers (attributes or denormalized DB columns). |
| `DEFAULT_THRESHOLDS`, `SIMILARITY_WEIGHTS`, `DEFAULT_MAX_CELLS`, `DEFAULT_BAND_RADIUS` | Tunables. |

Key output types (see `src/types.ts`):

```ts
interface DiffRow {
  status: 'same' | 'modified' | 'added' | 'removed';
  left?: SpanRef; right?: SpanRef;   // SpanRef carries ids, name, kind, signature, model, status,
                                     // tokens, costUsd, durationMs, orphan/placeholder, and `span`
  depth: number; parentIndex: number | null; end: number;   // rows[i+1..end) = subtree
  descendantsChanged: boolean;
  changes: FieldChange[];            // { field, category, left, right, delta?, ratio?, significant }
  movedTo?: number; movedFrom?: number;
}
interface RunDiff {
  rows: DiffRow[];
  firstDivergence: { rowIndex: number; phase: 'enter' | 'exit'; reasons: string[] } | null;
  summary: { left: RunTotals; right: RunTotals; delta: {...}; statusChanged: boolean; rows: {...} };
  alignment: { mode: 'exact' | 'banded'; cells: number; alignments: number };
}
```

`Span` accepts the optional denormalized columns (`model`, `input_tokens`, `output_tokens`, `cost_usd`) as numbers or numeric strings, so rows read straight from Postgres work as they are.

## Development

```sh
pnpm install
pnpm test        # vitest: scenarios, properties, perf (prints timings)
pnpm typecheck
pnpm build       # tsup → dist/index.js + dist/index.d.ts
```

Consume from the dashboard with `"@tracewright/run-diff": "file:../packages/run-diff"`, after running `pnpm build`.
