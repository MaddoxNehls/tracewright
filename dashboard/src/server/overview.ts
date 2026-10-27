import "server-only";
import { query } from "./db";
import { iso, num, numOrNull } from "./rows";
import { buildDailyQuery, buildModelBreakdownQuery, buildTotalsQuery } from "./sql/overview";

export interface DailyPoint {
  day: string;
  runs: number;
  errors: number;
  costUsd: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ModelBreakdown {
  model: string;
  runs: number;
  errors: number;
  /** Null when the model is not in the price table. */
  costUsd: number | null;
}

export interface OverviewTotals {
  windowStart: string;
  windowEnd: string;
  runs: number;
  errors: number;
  costUsd: number;
  tokens: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Overview {
  totals: OverviewTotals;
  daily: DailyPoint[];
  models: ModelBreakdown[];
}

type N = string | number | null;

export async function getOverview(projectId: string, days = 14): Promise<Overview> {
  const [totalRows, dailyRows, modelRows] = await Promise.all([
    query<{ window_start: Date; window_end: Date; runs: number; errors: number; cost_usd: N; tokens: N; p50_ms: N; p95_ms: N }>(
      buildTotalsQuery(projectId, days),
    ),
    query<{ day: Date; runs: number; errors: number; cost_usd: N; p50_ms: N; p95_ms: N }>(buildDailyQuery(projectId, days)),
    query<{ model: string; runs: number; errors: number; cost_usd: N }>(buildModelBreakdownQuery(projectId, days)),
  ]);

  const t = totalRows[0];
  if (!t) throw new Error("overview totals query returned no rows");

  return {
    totals: {
      windowStart: iso(t.window_start),
      windowEnd: iso(t.window_end),
      runs: t.runs,
      errors: t.errors,
      costUsd: num(t.cost_usd),
      tokens: num(t.tokens),
      p50Ms: numOrNull(t.p50_ms),
      p95Ms: numOrNull(t.p95_ms),
    },
    daily: dailyRows.map((r) => ({
      day: iso(r.day),
      runs: r.runs,
      errors: r.errors,
      costUsd: num(r.cost_usd),
      p50Ms: numOrNull(r.p50_ms),
      p95Ms: numOrNull(r.p95_ms),
    })),
    models: modelRows.map((r) => ({ model: r.model, runs: r.runs, errors: r.errors, costUsd: numOrNull(r.cost_usd) })),
  };
}
