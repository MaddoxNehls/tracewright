import { describe, expect, it } from "vitest";
import { generateDemoRuns } from "@/seed/research-agent";

describe("demo data generator", () => {
  const runs = generateDemoRuns(Date.UTC(2026, 9, 27));

  it("is deterministic", () => {
    expect(generateDemoRuns(Date.UTC(2026, 9, 27))).toEqual(runs);
  });

  it("produces well-formed traces that satisfy the wire contract", () => {
    expect(runs).toHaveLength(32);
    for (const run of runs) {
      expect(run.traceId).toMatch(/^[0-9a-f]{32}$/);
      const ids = new Set(run.spans.map((s) => s.spanId));
      expect(ids.size).toBe(run.spans.length);
      expect(run.spans.filter((s) => s.parentSpanId === null)).toHaveLength(1);
      for (const s of run.spans) {
        expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
        if (s.parentSpanId) expect(ids.has(s.parentSpanId)).toBe(true);
        expect(Date.parse(s.endTime)).toBeGreaterThanOrEqual(Date.parse(s.startTime));
        if (s.status === "error") expect(s.error).not.toBeNull();
      }
    }
  });

  it("includes failed runs and runs that recovered from a failed step", () => {
    expect(runs.filter((r) => r.status === "error")).toHaveLength(4);
    const recovered = runs.filter((r) => r.status === "ok" && r.spans.some((s) => s.status === "error"));
    expect(recovered.length).toBeGreaterThan(0);
  });
});
