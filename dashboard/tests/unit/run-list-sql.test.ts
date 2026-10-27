import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_LIST_PARAMS, parseRunListParams, runListQueryString, type RunListParams } from "@/lib/run-list-params";
import { escapeLike } from "@/server/sql/builder";
import { buildRunListQuery, decodeCursor, encodeCursor, isBackward } from "@/server/sql/run-list";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const TRACE = "0123456789abcdef0123456789abcdef";
const params = (patch: Partial<RunListParams> = {}): RunListParams => ({ ...DEFAULT_RUN_LIST_PARAMS, ...patch });
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("buildRunListQuery", () => {
  it("defaults to newest first, scoped to the project, fetching one extra row", () => {
    const q = buildRunListQuery({ projectId: PROJECT, params: params(), limit: 25 });
    const text = normalize(q.text);
    expect(text).toContain("FROM runs WHERE project_id = $1");
    expect(text).toContain("ORDER BY start_time DESC, trace_id DESC");
    expect(text).toContain("(start_time)::text AS sort_value");
    expect(text).toMatch(/LIMIT \$2$/);
    expect(q.values).toEqual([PROJECT, 26]);
  });

  it("adds each filter as a bound parameter, never inline", () => {
    const q = buildRunListQuery({
      projectId: PROJECT,
      params: params({ status: "error", model: "claude-sonnet-4-5", tag: "prod", q: "solar" }),
      limit: 10,
    });
    const text = normalize(q.text);
    expect(text).toContain("project_id = $1 AND status = $2 AND $3 = ANY(models) AND $4 = ANY(tags) AND name ILIKE $5");
    expect(q.values).toEqual([PROJECT, "error", "claude-sonnet-4-5", "prod", "%solar%", 11]);
    expect(text).not.toContain("solar");
  });

  it("escapes LIKE wildcards in the search text", () => {
    const q = buildRunListQuery({ projectId: PROJECT, params: params({ q: "100%_done\\" }), limit: 10 });
    expect(q.values).toContain(String.raw`%100\%\_done\\%`);
  });

  it.each([
    ["duration", "duration_ms", "double precision"],
    ["cost", "coalesce(total_cost_usd, 0)", "numeric"],
    ["tokens", "(total_input_tokens + total_output_tokens)", "bigint"],
  ] as const)("sorts by %s with a matching keyset cast", (sort, expr, cast) => {
    const cursor = encodeCursor({ value: "42", traceId: TRACE });
    const q = buildRunListQuery({ projectId: PROJECT, params: params({ sort, dir: "asc", cursor }), limit: 25 });
    const text = normalize(q.text);
    expect(text).toContain(`ORDER BY ${expr} ASC, trace_id ASC`);
    expect(text).toContain(`(${expr}, trace_id) > ($2::${cast}, $3)`);
    expect(q.values).toEqual([PROJECT, "42", TRACE, 26]);
  });

  it("uses < for descending keyset pagination and keeps filters before the cursor", () => {
    const cursor = encodeCursor({ value: "2026-10-27 14:00:00.123456+00", traceId: TRACE });
    const q = buildRunListQuery({ projectId: PROJECT, params: params({ status: "ok", cursor }), limit: 25 });
    expect(normalize(q.text)).toContain("status = $2 AND (start_time, trace_id) < ($3::timestamptz, $4)");
    expect(q.values).toEqual([PROJECT, "ok", "2026-10-27 14:00:00.123456+00", TRACE, 26]);
  });

  it("treats a malformed cursor as the first page", () => {
    const q = buildRunListQuery({ projectId: PROJECT, params: params({ cursor: "not-a-cursor" }), limit: 25 });
    expect(q.text).not.toContain("trace_id) <");
    expect(q.values).toEqual([PROJECT, 26]);
  });

  it("clamps the page size", () => {
    expect(buildRunListQuery({ projectId: PROJECT, params: params(), limit: 0 }).values.at(-1)).toBe(2);
    expect(buildRunListQuery({ projectId: PROJECT, params: params(), limit: 10_000 }).values.at(-1)).toBe(201);
  });
});

describe("cursors", () => {
  it("round-trip", () => {
    const c = { value: "2026-10-27 14:00:00.123456+00", traceId: TRACE };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("reject tampered payloads", () => {
    const bad = Buffer.from(JSON.stringify(["1", "'; DROP TABLE runs; --"])).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString("base64url"))).toBeNull();
    expect(decodeCursor("%%%")).toBeNull();
  });
});

describe("escapeLike", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLike(String.raw`a%b_c\d`)).toBe(String.raw`a\%b\_c\\d`);
  });
});

describe("run list URL params", () => {
  it("parses a whitelist and falls back to defaults", () => {
    expect(parseRunListParams({ status: "weird", sort: "drop", dir: "sideways", q: "  solar  ", model: ["a", "b"] })).toEqual({
      ...DEFAULT_RUN_LIST_PARAMS,
      q: "solar",
      model: "a",
    });
    expect(parseRunListParams({ status: "error", sort: "cost", dir: "asc" })).toMatchObject({ status: "error", sort: "cost", dir: "asc" });
  });

  it("omits defaults when serializing", () => {
    expect(runListQueryString(DEFAULT_RUN_LIST_PARAMS)).toBe("");
    expect(runListQueryString(DEFAULT_RUN_LIST_PARAMS, { status: "ok", sort: "cost" })).toBe("?status=ok&sort=cost");
  });

  it("drops the cursor whenever anything but the cursor changes", () => {
    const onPage2 = params({ tag: "prod", cursor: "abc" });
    expect(runListQueryString(onPage2, { status: "error" })).toBe("?status=error&tag=prod");
    expect(runListQueryString(onPage2, { cursor: "def" })).toBe("?tag=prod&cursor=def");
  });
});

describe("backward (Previous page) pagination", () => {
  const cursor = encodeCursor({ value: "2026-10-27 14:00:00+00", traceId: TRACE });

  it("walks the ordering in reverse from the cursor", () => {
    const q = buildRunListQuery({ projectId: PROJECT, params: params({ before: cursor }), limit: 25 });
    const text = normalize(q.text);
    expect(isBackward(params({ before: cursor }))).toBe(true);
    expect(text).toContain("(start_time, trace_id) > ($2::timestamptz, $3)");
    expect(text).toContain("ORDER BY start_time ASC, trace_id ASC");
    expect(q.values).toEqual([PROJECT, "2026-10-27 14:00:00+00", TRACE, 26]);
  });

  it("flips an ascending sort too", () => {
    const text = normalize(buildRunListQuery({ projectId: PROJECT, params: params({ sort: "cost", dir: "asc", before: cursor }), limit: 25 }).text);
    expect(text).toContain("< ($2::numeric, $3)");
    expect(text).toContain("ORDER BY coalesce(total_cost_usd, 0) DESC, trace_id DESC");
  });

  it("ignores a malformed before cursor", () => {
    expect(isBackward(params({ before: "garbage" }))).toBe(false);
    expect(buildRunListQuery({ projectId: PROJECT, params: params({ before: "garbage" }), limit: 25 }).values).toEqual([PROJECT, 26]);
  });

  it("parses and serializes before, and the two cursors are exclusive", () => {
    expect(parseRunListParams({ before: "abc" })).toMatchObject({ before: "abc", cursor: null });
    expect(parseRunListParams({ before: "abc", cursor: "def" })).toMatchObject({ before: null, cursor: "def" });
    const onPage = params({ status: "ok", cursor: "def" });
    expect(runListQueryString(onPage, { before: "abc", cursor: null })).toBe("?status=ok&before=abc");
    expect(runListQueryString(params({ before: "abc" }), { tag: "prod" })).toBe("?tag=prod");
  });
});
