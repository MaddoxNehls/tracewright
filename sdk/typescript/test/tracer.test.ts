import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSpan, init, run, type Span, shutdown, span, trace } from "../src/index.ts";
import { InMemoryExporter } from "../src/testing.ts";

let recorder: InMemoryExporter;

beforeEach(() => {
  recorder = new InMemoryExporter();
  init({ exporter: recorder });
});

afterEach(async () => {
  await shutdown();
});

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

describe("run", () => {
  it("creates a root agent span with tags, input and the result as output", async () => {
    const result = await run("research", async () => "42", { tags: ["demo", "v1"], input: { question: "?" } });

    expect(result).toBe("42");
    const root = only(recorder.spans);
    expect(root).toMatchObject({
      name: "research",
      kind: "agent",
      parent_span_id: null,
      status: "ok",
      error: null,
      input: { question: "?" },
      output: "42",
      attributes: { "tracewright.tags": ["demo", "v1"] },
    });
    expect(root.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(root.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("works with synchronous functions", () => {
    const result = run("sync", () => 7);
    expect(result).toBe(7);
    expect(only(recorder.spans).output).toBe(7);
  });

  it("keeps an output set explicitly instead of the return value", async () => {
    await run("explicit", async (root) => {
      root.setOutput({ answer: "final" });
      return "ignored";
    });
    expect(only(recorder.spans).output).toEqual({ answer: "final" });
  });

  it("starts a fresh trace even when nested inside another run", async () => {
    await run("outer", async () => {
      await run("inner", async () => undefined);
    });
    const [inner, outer] = recorder.spans;
    expect(inner?.parent_span_id).toBeNull();
    expect(inner?.trace_id).not.toBe(outer?.trace_id);
  });

  it("emits RFC3339Nano UTC timestamps with end >= start", async () => {
    await run("timed", () => delay(5));
    const root = only(recorder.spans);
    const rfc3339Nano = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;
    expect(root.start_time).toMatch(rfc3339Nano);
    expect(root.end_time).toMatch(rfc3339Nano);
    expect(root.end_time > root.start_time).toBe(true);
    expect(Math.abs(Date.parse(root.start_time) - Date.now())).toBeLessThan(5000);
  });
});

describe("span tree", () => {
  it("parents nested spans across awaits", async () => {
    await run("agent", async () => {
      await span("step", async () => {
        await delay(1);
        await span("leaf", async () => delay(1), { kind: "tool" });
      });
    });

    const [root] = recorder.roots();
    const step = only(recorder.byName("step"));
    const leaf = only(recorder.byName("leaf"));
    expect(step.parent_span_id).toBe(root?.span_id);
    expect(leaf.parent_span_id).toBe(step.span_id);
    expect(leaf.kind).toBe("tool");
    expect(new Set(recorder.spans.map((s) => s.trace_id)).size).toBe(1);
  });

  it("gives concurrent branches the correct parents under Promise.all", async () => {
    const tool = trace(
      async (_branch: string, ms: number) => {
        await delay(ms);
        return getCurrentSpan()?.name;
      },
      { kind: "tool", name: "tool" },
    );

    await run("agent", () =>
      Promise.all(
        ["a", "b", "c"].map((branch, i) =>
          span(`branch-${branch}`, async () => {
            // Stagger so the branches interleave: c finishes first, a last.
            await tool(branch, (3 - i) * 5);
            await tool(branch, 1);
          }),
        ),
      ),
    );

    expect(recorder.spans).toHaveLength(1 + 3 + 6);
    for (const branch of ["a", "b", "c"]) {
      const parent = only(recorder.byName(`branch-${branch}`));
      const children = recorder.childrenOf(parent.span_id);
      expect(children).toHaveLength(2);
      for (const child of children) expect(child.input).toEqual([branch, expect.any(Number)]);
    }
    for (const toolSpan of recorder.byName("tool")) expect(toolSpan.output).toBe("tool");
  });

  it("exposes the current span inside callbacks and nothing outside", async () => {
    expect(getCurrentSpan()).toBeUndefined();
    await run("agent", async (root) => {
      expect(getCurrentSpan()).toBe(root);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          expect(getCurrentSpan()).toBe(root);
          resolve();
        }, 1),
      );
    });
    expect(getCurrentSpan()).toBeUndefined();
  });

  it("starts a new trace for a span opened outside any run", () => {
    span("orphan", () => undefined);
    expect(only(recorder.spans)).toMatchObject({ name: "orphan", kind: "custom", parent_span_id: null });
  });
});

describe("errors", () => {
  it("records and rethrows synchronous errors", () => {
    expect(() =>
      run("agent", () => {
        throw new TypeError("bad input");
      }),
    ).toThrow(TypeError);
    expect(only(recorder.spans)).toMatchObject({
      status: "error",
      error: { type: "TypeError", message: "bad input" },
    });
  });

  it("records and rethrows async rejections, marking only the failing branch", async () => {
    const failing = trace(
      async () => {
        throw new RangeError("boom");
      },
      { name: "failing", kind: "tool" },
    );

    await expect(
      run("agent", async () => {
        await span("fine", async () => "ok");
        await failing();
      }),
    ).rejects.toThrow("boom");

    expect(only(recorder.byName("fine")).status).toBe("ok");
    expect(only(recorder.byName("failing"))).toMatchObject({
      status: "error",
      error: { type: "RangeError", message: "boom" },
      attributes: { "gen_ai.tool.name": "failing" },
    });
    expect(only(recorder.roots()).status).toBe("error");
  });

  it("handles thrown non-Error values", async () => {
    await expect(
      span("agent", async () => {
        throw "plain string";
      }),
    ).rejects.toBe("plain string");
    expect(only(recorder.spans).error).toEqual({ type: "UnknownError", message: "plain string" });
  });
});

describe("trace", () => {
  it("preserves the function's type, this, and name", () => {
    class Calculator {
      factor = 3;
      multiply = trace(function (this: Calculator, x: number) {
        return x * this.factor;
      });
    }
    const add = trace(function add(a: number, b: number) {
      return a + b;
    });

    expect(new Calculator().multiply(2)).toBe(6);
    expect(add(2, 3)).toBe(5);
    expect(add.name).toBe("add");
    expect(recorder.byName("add")[0]).toMatchObject({ input: [2, 3], output: 5, kind: "custom" });
  });

  it("can skip input and output capture", async () => {
    const secret = trace(async (token: string) => `${token}!`, {
      name: "secret",
      captureInput: false,
      captureOutput: false,
    });
    await secret("hunter2");
    expect(only(recorder.spans)).toMatchObject({ input: null, output: null });
  });

  it("snapshots inputs so later mutation is not recorded", () => {
    const messages = [{ role: "user", content: "hi" }];
    const step = trace((history: typeof messages) => history.length, { name: "step" });
    step(messages);
    messages.push({ role: "assistant", content: "hello" });
    expect(only(recorder.spans).input).toEqual([[{ role: "user", content: "hi" }]]);
  });
});

describe("span limits", () => {
  it("truncates names to 256 characters and defaults empty names", () => {
    span("x".repeat(300), () => undefined);
    span("", () => undefined);
    const [long, empty] = recorder.spans;
    expect(long?.name).toHaveLength(256);
    expect(empty?.name).toBe("span");
  });

  it("counts the name limit in code points without splitting surrogate pairs", () => {
    span("🦀".repeat(300), () => undefined);
    const name = recorder.spans[0]?.name ?? "";
    expect(Array.from(name)).toHaveLength(256);
    expect(name.isWellFormed()).toBe(true);
  });

  it("ignores mutation after a span has ended", () => {
    let captured: Span | undefined;
    span("closed", (s) => {
      captured = s;
    });
    captured?.setAttribute("late", true).setOutput("late");
    expect(captured?.ended).toBe(true);
    expect(captured?.attributes).toEqual({});
  });
});
