import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, MAX_PAYLOAD_BYTES, shutdown, span } from "../src/index.ts";
import { toJsonable, truncatePayload } from "../src/serialize.ts";
import { InMemoryExporter } from "../src/testing.ts";

describe("toJsonable", () => {
  it("replaces circular references but copies shared ones", () => {
    const shared = { id: 1 };
    const node: Record<string, unknown> = { a: shared, b: shared };
    node["self"] = node;
    expect(toJsonable(node)).toEqual({ a: { id: 1 }, b: { id: 1 }, self: "[Circular]" });
  });

  it("converts values JSON cannot represent", () => {
    const value = {
      big: 2n ** 70n,
      nan: Number.NaN,
      inf: Number.NEGATIVE_INFINITY,
      fn: function handler() {},
      sym: Symbol("tag"),
      undef: undefined,
      date: new Date("2026-01-02T03:04:05.000Z"),
      map: new Map<unknown, unknown>([
        ["k", 1],
        [2, "two"],
      ]),
      set: new Set([1, 2]),
      bytes: new Uint8Array(12),
      list: [undefined, 1],
    };
    expect(toJsonable(value)).toEqual({
      big: "1180591620717411303424",
      nan: "NaN",
      inf: "-Infinity",
      fn: "[Function handler]",
      sym: "Symbol(tag)",
      date: "2026-01-02T03:04:05.000Z",
      map: { k: 1, "2": "two" },
      set: [1, 2],
      bytes: "<12 bytes>",
      list: [null, 1],
    });
  });

  it("serializes errors with their cause", () => {
    const error = new Error("outer", { cause: new TypeError("inner") });
    const result = toJsonable(error) as Record<string, unknown>;
    expect(result).toMatchObject({ type: "Error", message: "outer", cause: { type: "TypeError", message: "inner" } });
    expect(result["stack"]).toEqual(expect.stringContaining("outer"));
  });

  it("honours toJSON and survives a throwing one", () => {
    const good = { toJSON: () => ({ via: "toJSON" }) };
    const bad = {
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(toJsonable({ good, bad })).toEqual({ good: { via: "toJSON" }, bad: "[Object]" });
  });

  it("survives throwing getters", () => {
    const hostile = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    expect(toJsonable(hostile)).toBe("[Object]");
  });

  it("caps nesting depth", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 100; i++) deep = { next: deep };
    expect(JSON.stringify(toJsonable(deep))).toContain("[MaxDepth]");
  });
});

describe("truncatePayload", () => {
  it("leaves small payloads alone", () => {
    expect(truncatePayload({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
    expect(truncatePayload(null)).toEqual({ value: null, truncated: false });
  });

  it("cuts oversized payloads to a marked JSON prefix within the limit", () => {
    const { value, truncated } = truncatePayload({ text: "a".repeat(2000) }, 1000);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
    expect(value).toMatch(/^\{"text":"a+\.\.\.\[truncated by tracewright\]$/);
    expect(Buffer.byteLength(value as string)).toBeLessThanOrEqual(1000);
  });

  it("never splits a multi-byte character", () => {
    const { value } = truncatePayload("🦀".repeat(1000), 501);
    expect(value).not.toContain("�");
    expect(Buffer.byteLength(value as string)).toBeLessThanOrEqual(501);
  });
});

describe("span payload truncation", () => {
  let recorder: InMemoryExporter;
  beforeEach(() => {
    recorder = new InMemoryExporter();
    init({ exporter: recorder });
  });
  afterEach(() => shutdown());

  it("flags truncated input/output with tracewright.truncated", () => {
    span("big", () => "x".repeat(MAX_PAYLOAD_BYTES + 10), { input: "small" });
    const [record] = recorder.spans;
    expect(record?.input).toBe("small");
    expect(record?.output).toEqual(expect.stringMatching(/truncated by tracewright\]$/));
    expect(record?.attributes["tracewright.truncated"]).toBe(true);
  });

  it("does not flag spans within the limit", () => {
    span("small", () => "x".repeat(100));
    expect(recorder.spans[0]?.attributes).not.toHaveProperty("tracewright.truncated");
  });
});
