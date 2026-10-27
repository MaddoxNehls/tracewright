import { describe, expect, it } from "vitest";
import { ancestorPath, barGeometry, buildSpanTree, layoutWaterfall, timeTicks, traceWindow, type TimedSpan } from "@/lib/waterfall";

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();
const span = (spanId: string, parentSpanId: string | null, start: number, end: number, name = spanId): TimedSpan => ({
  spanId,
  parentSpanId,
  name,
  startTime: at(start),
  endTime: at(end),
});

// root (0-1000)
// ├─ a (100-400)
// │  └─ a1 (150-300)
// └─ b (500-1000)
const SPANS = [span("b", "root", 500, 1000), span("a1", "a", 150, 300), span("root", null, 0, 1000), span("a", "root", 100, 400)];

describe("buildSpanTree", () => {
  it("nests by parent and orders siblings by start time", () => {
    const [root, ...rest] = buildSpanTree(SPANS);
    expect(rest).toHaveLength(0);
    expect(root?.span.spanId).toBe("root");
    expect(root?.children.map((c) => c.span.spanId)).toEqual(["a", "b"]);
    expect(root?.children[0]?.children.map((c) => c.span.spanId)).toEqual(["a1"]);
  });

  it("promotes spans with a missing parent to roots instead of dropping them", () => {
    const roots = buildSpanTree([...SPANS, span("orphan", "never-arrived", 50, 60)]);
    expect(roots.map((r) => r.span.spanId)).toEqual(["root", "orphan"]);
  });

  it("does not loop on a span that names itself as parent", () => {
    expect(buildSpanTree([span("x", "x", 0, 10)]).map((r) => r.span.spanId)).toEqual(["x"]);
  });
});

describe("traceWindow and barGeometry", () => {
  it("spans the earliest start to the latest end", () => {
    expect(traceWindow(SPANS)).toEqual({ startMs: T0, endMs: T0 + 1000, totalMs: 1000 });
  });

  it("positions bars as percentages of the window", () => {
    const win = traceWindow(SPANS);
    expect(barGeometry(span("a", null, 100, 400), win)).toEqual({ offsetPct: 10, widthPct: 30 });
    expect(barGeometry(span("b", null, 500, 1000), win)).toEqual({ offsetPct: 50, widthPct: 50 });
  });

  it("clamps bars that fall outside the window or end before they start", () => {
    const win = traceWindow(SPANS);
    expect(barGeometry(span("late", null, 900, 5000), win)).toEqual({ offsetPct: 90, widthPct: 10 });
    expect(barGeometry(span("neg", null, 300, 200), win)).toEqual({ offsetPct: 30, widthPct: 0 });
  });

  it("gives an empty or zero-length trace a non-zero window", () => {
    expect(traceWindow([]).totalMs).toBe(1);
    const win = traceWindow([span("p", null, 0, 0)]);
    expect(win.totalMs).toBe(1);
    expect(barGeometry(span("p", null, 0, 0), win)).toEqual({ offsetPct: 0, widthPct: 0 });
  });
});

describe("layoutWaterfall", () => {
  const tree = buildSpanTree(SPANS);
  const win = traceWindow(SPANS);

  it("flattens depth-first with depths and child flags", () => {
    const rows = layoutWaterfall(tree, win);
    expect(rows.map((r) => [r.span.spanId, r.depth, r.hasChildren])).toEqual([
      ["root", 0, true],
      ["a", 1, true],
      ["a1", 2, false],
      ["b", 1, false],
    ]);
    expect(rows[2]).toMatchObject({ offsetPct: 15, widthPct: 15 });
  });

  it("hides descendants of collapsed spans but keeps the span itself", () => {
    const rows = layoutWaterfall(tree, win, new Set(["a"]));
    expect(rows.map((r) => r.span.spanId)).toEqual(["root", "a", "b"]);
    expect(rows[1]?.collapsed).toBe(true);
  });

  it("ignores collapse on a leaf", () => {
    const rows = layoutWaterfall(tree, win, new Set(["b"]));
    expect(rows.find((r) => r.span.spanId === "b")?.collapsed).toBe(false);
  });
});

describe("timeTicks", () => {
  it.each([
    [1000, 5, [0, 200, 400, 600, 800, 1000]],
    [38_900, 6, [0, 10_000, 20_000, 30_000]],
    [7, 5, [0, 2, 4, 6]],
  ])("picks 1/2/5 steps for %d ms", (total, target, expected) => {
    expect(timeTicks(total, target)).toEqual(expected);
  });

  it("handles degenerate input", () => {
    expect(timeTicks(0)).toEqual([0]);
    expect(timeTicks(Number.NaN)).toEqual([0]);
  });
});

describe("ancestorPath", () => {
  it("walks from the root to the span", () => {
    expect(ancestorPath(SPANS, "a1")).toEqual(["root", "a", "a1"]);
    expect(ancestorPath(SPANS, "missing")).toEqual([]);
  });
});
