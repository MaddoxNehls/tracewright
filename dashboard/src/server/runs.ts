import "server-only";
import type { RunListParams } from "@/lib/run-list-params";
import type { RunDetail, RunSummary } from "@/lib/types";
import { query } from "./db";
import { toRunSummary, toSpan, type RunRow, type SpanRow } from "./rows";
import { Params } from "./sql/builder";
import { buildRunListQuery, encodeCursor, RUN_COLUMNS } from "./sql/run-list";

export const RUN_PAGE_SIZE = 25;

export interface RunPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

export async function listRuns(projectId: string, params: RunListParams, limit = RUN_PAGE_SIZE): Promise<RunPage> {
  const rows = await query<RunRow & { sort_value: string }>(buildRunListQuery({ projectId, params, limit }));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor({ value: last.sort_value, traceId: last.trace_id }) : null;
  return { runs: page.map(toRunSummary), nextCursor };
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
