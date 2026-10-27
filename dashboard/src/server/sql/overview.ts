/**
 * Aggregate queries for the project overview. The window is anchored on the
 * project's most recent run (not now()), so a demo seeded weeks ago still
 * shows its activity instead of an empty chart.
 */
import { Params, type BuiltQuery } from "./builder";

const WINDOW_CTE = (p: Params, projectId: string, days: number) => {
  const pid = p.add(projectId);
  const d = p.add(Math.min(Math.max(Math.trunc(days), 1), 90));
  return {
    pid,
    cte: `bounds AS (
  SELECT date_trunc('day', coalesce(max(start_time), now()), 'UTC') + interval '1 day' AS window_end
  FROM runs WHERE project_id = ${pid}
), win AS (
  SELECT window_end - make_interval(days => ${d}::int) AS window_start, window_end FROM bounds
)`,
  };
};

/** One row per UTC day in the window, including empty days. */
export function buildDailyQuery(projectId: string, days: number): BuiltQuery {
  const p = new Params();
  const { pid, cte } = WINDOW_CTE(p, projectId, days);
  const text = `WITH ${cte}, series AS (
  SELECT generate_series(win.window_start, win.window_end - interval '1 day', interval '1 day') AS day FROM win
)
SELECT
  series.day,
  count(r.trace_id)::int AS runs,
  (count(r.trace_id) FILTER (WHERE r.status = 'error'))::int AS errors,
  coalesce(sum(r.total_cost_usd), 0)::float8 AS cost_usd,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r.duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) AS p95_ms
FROM series
LEFT JOIN runs r
  ON r.project_id = ${pid}
 AND r.start_time >= series.day
 AND r.start_time < series.day + interval '1 day'
GROUP BY series.day
ORDER BY series.day`;
  return { text, values: p.values };
}

export function buildTotalsQuery(projectId: string, days: number): BuiltQuery {
  const p = new Params();
  const { pid, cte } = WINDOW_CTE(p, projectId, days);
  const text = `WITH ${cte}
SELECT
  win.window_start,
  win.window_end,
  count(r.trace_id)::int AS runs,
  (count(r.trace_id) FILTER (WHERE r.status = 'error'))::int AS errors,
  coalesce(sum(r.total_cost_usd), 0)::float8 AS cost_usd,
  coalesce(sum(r.total_input_tokens + r.total_output_tokens), 0)::float8 AS tokens,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY r.duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) AS p95_ms
FROM win
LEFT JOIN runs r
  ON r.project_id = ${pid}
 AND r.start_time >= win.window_start
 AND r.start_time < win.window_end
GROUP BY win.window_start, win.window_end`;
  return { text, values: p.values };
}

/** Runs and cost per model. A run that used two models counts toward both. */
export function buildModelBreakdownQuery(projectId: string, days: number): BuiltQuery {
  const p = new Params();
  const { pid, cte } = WINDOW_CTE(p, projectId, days);
  const text = `WITH ${cte}
SELECT
  m.model,
  count(*)::int AS runs,
  (count(*) FILTER (WHERE r.status = 'error'))::int AS errors,
  -- NULL (not 0) when no run of this model has a known price.
  sum(r.total_cost_usd)::float8 AS cost_usd
FROM runs r
CROSS JOIN win
CROSS JOIN LATERAL unnest(r.models) AS m(model)
WHERE r.project_id = ${pid}
  AND r.start_time >= win.window_start
  AND r.start_time < win.window_end
GROUP BY m.model
ORDER BY runs DESC, m.model`;
  return { text, values: p.values };
}
