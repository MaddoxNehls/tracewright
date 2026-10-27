/**
 * SQL for the run list: filters, sort, and keyset (cursor) pagination.
 * Pure: builds `{ text, values }` and never touches the database, so the
 * shape of every query is unit tested.
 */
import type { RunListParams, SortKey } from "@/lib/run-list-params";
import { escapeLike, Params, type BuiltQuery } from "./builder";

interface SortSpec {
  /** Expression ordered by. Also re-selected as text to build the next cursor. */
  expr: string;
  /** Type the cursor's text value is cast back to. */
  cast: string;
}

export const SORT_SPECS: Record<SortKey, SortSpec> = {
  started: { expr: "start_time", cast: "timestamptz" },
  duration: { expr: "duration_ms", cast: "double precision" },
  // Unknown-model runs have NULL cost; sort them as zero so keyset comparison stays total.
  cost: { expr: "coalesce(total_cost_usd, 0)", cast: "numeric" },
  tokens: { expr: "(total_input_tokens + total_output_tokens)", cast: "bigint" },
};

export const RUN_COLUMNS = [
  "trace_id",
  "name",
  "status",
  "start_time",
  "end_time",
  "duration_ms",
  "span_count",
  "llm_call_count",
  "tool_call_count",
  "total_input_tokens",
  "total_output_tokens",
  "total_cost_usd",
  "tags",
  "models",
].join(", ");

/**
 * A cursor is the (sort value, trace_id) of the last row on the previous page.
 * The sort value is carried as Postgres text so timestamps keep microsecond
 * precision and floats round-trip exactly.
 */
export interface RunCursor {
  value: string;
  traceId: string;
}

export function encodeCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.value, cursor.traceId]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): RunCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      /^[0-9a-f]{1,64}$/i.test(parsed[1])
    ) {
      return { value: parsed[0], traceId: parsed[1] };
    }
  } catch {
    // fall through: malformed cursors are treated as "first page"
  }
  return null;
}

export interface RunListQueryInput {
  projectId: string;
  params: RunListParams;
  /** Page size. The query fetches one extra row to detect a next page. */
  limit: number;
}

export function buildRunListQuery({ projectId, params, limit }: RunListQueryInput): BuiltQuery {
  const p = new Params();
  const sort = SORT_SPECS[params.sort];
  const dir = params.dir === "asc" ? "ASC" : "DESC";

  const where = [`project_id = ${p.add(projectId)}`];
  if (params.status) where.push(`status = ${p.add(params.status)}`);
  if (params.model) where.push(`${p.add(params.model)} = ANY(models)`);
  if (params.tag) where.push(`${p.add(params.tag)} = ANY(tags)`);
  if (params.q) where.push(`name ILIKE ${p.add(`%${escapeLike(params.q)}%`)}`);

  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (cursor) {
    // Row-value comparison matches ORDER BY (expr, trace_id) when both use the same direction.
    const op = dir === "DESC" ? "<" : ">";
    where.push(`(${sort.expr}, trace_id) ${op} (${p.add(cursor.value)}::${sort.cast}, ${p.add(cursor.traceId)})`);
  }

  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const text = [
    `SELECT ${RUN_COLUMNS}, (${sort.expr})::text AS sort_value`,
    "FROM runs",
    `WHERE ${where.join(" AND ")}`,
    `ORDER BY ${sort.expr} ${dir}, trace_id ${dir}`,
    `LIMIT ${p.add(safeLimit + 1)}`,
  ].join("\n");

  return { text, values: p.values };
}
