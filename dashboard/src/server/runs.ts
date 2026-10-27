import "server-only";
import type { RunListParams } from "@/lib/run-list-params";
import type { RunDetail, RunSummary } from "@/lib/types";
import { query } from "./db";
import { toRunSummary, toSpan, type RunRow, type SpanRow } from "./rows";
import { Params } from "./sql/builder";
import { buildRunListQuery, decodeCursor, encodeCursor, isBackward, RUN_COLUMNS } from "./sql/run-list";

export const RUN_PAGE_SIZE = 25;

export interface RunPage {
  runs: RunSummary[];
  /** `cursor` for the next page, or null on the last page. */
  nextCursor: string | null;
  /** `before` for the previous page, or null on the first page. */
  prevCursor: string | null;
}

type SortedRunRow = RunRow & { sort_value: string };
const cursorOf = (r: SortedRunRow | undefined) => (r ? encodeCursor({ value: r.sort_value, traceId: r.trace_id }) : null);

export async function listRuns(projectId: string, params: RunListParams, limit = RUN_PAGE_SIZE): Promise<RunPage> {
  const rows = await query<SortedRunRow>(buildRunListQuery({ projectId, params, limit }));
  // The query fetches one extra row in its own direction: it says whether more rows lie that way.
  const more = rows.length > limit;
  if (isBackward(params)) {
    const page = rows.slice(0, limit).reverse();
    return { runs: page.map(toRunSummary), nextCursor: cursorOf(page.at(-1)), prevCursor: more ? cursorOf(page[0]) : null };
  }
  const page = rows.slice(0, limit);
  return {
    runs: page.map(toRunSummary),
    nextCursor: more ? cursorOf(page.at(-1)) : null,
    prevCursor: params.cursor && decodeCursor(params.cursor) ? cursorOf(page[0]) : null,
  };
}

export interface RunSibling {
  traceId: string;
  status: RunSummary["status"];
  startTime: string;
  durationMs: number;
  costUsd: number | null;
  tags: string[];
  models: string[];
}

/** Recent runs with the same name: the natural candidates to compare a run against. */
export async function listSiblingRuns(projectId: string, name: string, excludeTraceId: string, limit = 12): Promise<RunSibling[]> {
  const p = new Params();
  const rows = await query<RunRow>({
    text: `SELECT ${RUN_COLUMNS} FROM runs
WHERE project_id = ${p.add(projectId)} AND name = ${p.add(name)} AND trace_id <> ${p.add(excludeTraceId)}
ORDER BY start_time DESC, trace_id DESC
LIMIT ${p.add(limit)}`,
    values: p.values,
  });
  return rows.map(toRunSummary).map(({ traceId, status, startTime, durationMs, costUsd, tags, models }) => ({
    traceId,
    status,
    startTime,
    durationMs,
    costUsd,
    tags,
    models,
  }));
}

export interface RunFacets {
  models: string[];
  tags: string[];
}

/** Distinct models and tags in the project, for the filter menus. */
export async function getRunFacets(projectId: string): Promise<RunFacets> {
  const p = new Params();
  const pid = p.add(projectId);
  const rows = await query<{ facet: "model" | "tag"; value: string }>({
    text: `SELECT DISTINCT 'model' AS facet, unnest(models) AS value FROM runs WHERE project_id = ${pid}
UNION
SELECT DISTINCT 'tag' AS facet, unnest(tags) AS value FROM runs WHERE project_id = ${pid}
ORDER BY facet, value`,
    values: p.values,
  });
  return {
    models: rows.filter((r) => r.facet === "model").map((r) => r.value),
    tags: rows.filter((r) => r.facet === "tag").map((r) => r.value),
  };
}

const TRACE_ID = /^[0-9a-f]{32}$/;

export async function getRunDetail(projectId: string, traceId: string): Promise<RunDetail | null> {
  if (!TRACE_ID.test(traceId)) return null;

  const runQ = new Params();
  const spanQ = new Params();
  const [runRows, spanRows] = await Promise.all([
    query<RunRow>({
      text: `SELECT ${RUN_COLUMNS} FROM runs WHERE project_id = ${runQ.add(projectId)} AND trace_id = ${runQ.add(traceId)}`,
      values: runQ.values,
    }),
    query<SpanRow>({
      text: `SELECT span_id, parent_span_id, name, kind, start_time, end_time, duration_ms, status, error,
       attributes, input, output, model, input_tokens, output_tokens, cost_usd
FROM spans
WHERE project_id = ${spanQ.add(projectId)} AND trace_id = ${spanQ.add(traceId)}
ORDER BY start_time, span_id`,
      values: spanQ.values,
    }),
  ]);

  const run = runRows[0];
  if (!run) return null;
  return { run: toRunSummary(run), spans: spanRows.map(toSpan) };
}
