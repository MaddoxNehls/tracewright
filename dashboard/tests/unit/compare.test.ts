import { diffRuns } from "@tracewright/run-diff";
import { describe, expect, it } from "vitest";
import { compareRuns, discountReplayedTiming, isReplayed, replayInfo, toWireSpan } from "@/lib/compare";
import { generateDiffPairs, type GeneratedRun } from "@/seed/research-agent";
import { PRICES } from "@/server/pricing";

const pairs = generateDiffPairs(Date.UTC(2026, 9, 27, 12), PRICES);
const pair = (label: string) => {
  const p = pairs.find((x) => x.label.startsWith(label));
  if (!p) throw new Error(label);
  return p;
};
const side = (run: GeneratedRun) => ({ traceId: run.traceId, spans: run.spans });
const nameAt = (rows: ReturnType<typeof compareRuns>["diff"]["rows"], i: number) => {
  const row = rows[i];
  return row?.right?.name ?? row?.left?.name;
};

describe("toWireSpan", () => {
  it("maps the stored span back to the snake_case wire contract", () => {
    const span = pairs[0]!.baseline.spans[1]!;
    expect(toWireSpan("t".repeat(32), span)).toMatchObject({
      trace_id: "t".repeat(32),
      span_id: span.spanId,
      parent_span_id: span.parentSpanId,
      start_time: span.startTime,
      input_tokens: span.inputTokens,
      cost_usd: span.costUsd,
    });
  });
});

describe("replay metadata", () => {
  const { baseline, candidate } = pair("Replay");

  it("reads replay_of and replay_from_step from the root span", () => {
    expect(replayInfo(candidate.spans)).toEqual({ of: baseline.traceId, fromStep: 4 });
    expect(replayInfo(baseline.spans)).toBeNull();
  });

  it("marks served calls, with no LLM spend", () => {
    const served = candidate.spans.filter((s) => isReplayed(s.attributes));
    expect(served.length).toBeGreaterThan(0);
    expect(served.filter((s) => s.kind === "llm").every((s) => s.costUsd === 0)).toBe(true);
    expect(candidate.spans.find((s) => s.name === "synthesize")?.attributes["tracewright.replayed"]).toBeUndefined();
  });
});

describe("compareRuns on the seeded pairs", () => {
  it("model swap: diverges at the synthesis call, before it ran, because the model changed", () => {
    const { baseline, candidate } = pair("Model swap");
    const { diff, replayPair } = compareRuns(side(baseline), side(candidate));
    expect(replayPair).toBe(false);
    expect(diff.summary.statusChanged).toBe(true);
    const first = diff.firstDivergence!;
    expect(first.phase).toBe("enter");
    expect(first.reasons).toContain("model");
    expect(nameAt(diff.rows, first.rowIndex)).toBe("chat claude-sonnet-5-5");
  });

  it("extra loop: the first divergence is an added search step, and cost roughly triples", () => {
    const { baseline, candidate } = pair("Extra search loop");
    const { diff } = compareRuns(side(baseline), side(candidate));
    expect(diff.firstDivergence?.reasons).toEqual(["added"]);
    expect(nameAt(diff.rows, diff.firstDivergence!.rowIndex)).toMatch(/^search: /);
    expect(diff.summary.rows.added).toBeGreaterThanOrEqual(3 * 4);
    const ratio = diff.summary.right.costUsd! / diff.summary.left.costUsd!;
    expect(ratio).toBeGreaterThan(2.5);
  });

  it("replay: replayed steps count as unchanged, so the divergence is the live step's new model", () => {
    const { baseline, candidate } = pair("Replay");
    const { diff, replayPair } = compareRuns(side(baseline), side(candidate));
    expect(replayPair).toBe(true);
    for (const row of diff.rows) {
      if (isReplayed(row.right?.span.attributes)) expect(row.status).toBe("same");
    }
    expect(nameAt(diff.rows, diff.firstDivergence!.rowIndex)).toBe("chat claude-opus-5-5");
    expect(diff.firstDivergence?.reasons).toContain("model");
  });

  it("without the replay discount, serving from the recording would be blamed first", () => {
    const { baseline, candidate } = pair("Replay");
    const raw = diffRuns(
      baseline.spans.map((s) => toWireSpan(baseline.traceId, s)),
      candidate.spans.map((s) => toWireSpan(candidate.traceId, s)),
    );
    const discounted = discountReplayedTiming(raw);
    expect(raw.firstDivergence!.rowIndex).toBeLessThan(discounted.firstDivergence!.rowIndex);
    expect(isReplayed(raw.rows[raw.firstDivergence!.rowIndex]?.right?.span.attributes)).toBe(true);
    expect(discounted.summary.rows.modified).toBeLessThan(raw.summary.rows.modified);
  });

  it("identical runs have no divergence", () => {
    const { baseline } = pair("Model swap");
    const { diff } = compareRuns(side(baseline), side(baseline));
    expect(diff.firstDivergence).toBeNull();
    expect(diff.rows.every((r) => r.status === "same")).toBe(true);
  });
});

describe("priced seed data", () => {
  it("PRICES calls from ingest's table and leaves unknown models null", async () => {
    const { priceCall } = await import("@/lib/pricing");
    expect(priceCall(PRICES, "claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12);
    // Haiku 5.5's long-context tier applies above 100k input tokens.
    expect(priceCall(PRICES, "claude-haiku-5-5", 200_000, 0)).toBe(0.1);
    expect(priceCall(PRICES, "openai/gpt-5-mini", 1000, 1000)).toBeNull();
    const llm = pair("Model swap").candidate.spans.filter((s) => s.kind === "llm");
    for (const s of llm) expect(s.costUsd).toBe(priceCall(PRICES, s.model!, s.inputTokens!, s.outputTokens!));
  });
});
