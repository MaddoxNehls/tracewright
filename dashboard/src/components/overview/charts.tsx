"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";
import { formatCost, formatDay, formatDuration, formatTick } from "@/lib/format";

export interface DailyDatum {
  day: string;
  ok: number;
  errors: number;
  costUsd: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

const HEIGHT = 200;
const axisProps = {
  stroke: "var(--chart-axis)",
  tick: { fill: "var(--chart-axis)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

const dayTick = (iso: string) => formatDay(iso);

interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  format: (v: number) => string;
}

/** One tooltip for every chart: the day, then each series with its swatch. Text stays in ink colors. */
type TooltipArgs = Pick<TooltipContentProps<TooltipValueType, string | number>, "active" | "payload" | "label">;

function ChartTooltip({ active, payload, label, series }: TooltipArgs & { series: SeriesSpec[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Record<string, number | null> | undefined;
  return (
    <div className="rounded-md border border-border-strong bg-surface px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-medium text-fg">{formatDay(String(label))}</div>
      {series.map((s) => {
        const v = row?.[s.key];
        return (
          <div key={s.key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-fg-muted">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
            <span className="tabular text-fg">{v == null ? "–" : s.format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: SeriesSpec[] }) {
  return (
    <ul className="flex items-center gap-3 text-[11.5px] text-fg-muted" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartCard({ title, subtitle, legend, children }: { title: string; subtitle?: string; legend?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-4" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {subtitle && <p className="text-[12px] text-fg-subtle">{subtitle}</p>}
        </div>
        {legend}
      </div>
      {children}
    </section>
  );
}

const RUN_SERIES: SeriesSpec[] = [
  { key: "ok", label: "OK", color: "var(--ok)", format: String },
  { key: "errors", label: "Error", color: "var(--err)", format: String },
];

export function RunsPerDayChart({ data }: { data: DailyDatum[] }) {
  return (
    <ChartCard title="Runs per day" subtitle="Stacked by final status" legend={<Legend series={RUN_SERIES} />}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="day" tickFormatter={dayTick} {...axisProps} minTickGap={16} />
          <YAxis allowDecimals={false} {...axisProps} width={44} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p) => <ChartTooltip {...p} series={RUN_SERIES} />} />
          <Bar dataKey="ok" stackId="runs" fill="var(--ok)" maxBarSize={24} stroke="var(--surface)" strokeWidth={1} />
          <Bar dataKey="errors" stackId="runs" fill="var(--err)" maxBarSize={24} radius={[4, 4, 0, 0]} stroke="var(--surface)" strokeWidth={1} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const COST_SERIES: SeriesSpec[] = [{ key: "costUsd", label: "Cost", color: "var(--series-1)", format: formatCost }];

export function CostPerDayChart({ data }: { data: DailyDatum[] }) {
  return (
    <ChartCard title="Cost per day" subtitle="Sum of LLM spend, USD">
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="day" tickFormatter={dayTick} {...axisProps} minTickGap={16} />
          <YAxis tickFormatter={(v: number) => `$${v.toFixed(2)}`} {...axisProps} width={52} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p) => <ChartTooltip {...p} series={COST_SERIES} />} />
          <Bar dataKey="costUsd" fill="var(--series-1)" maxBarSize={24} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const LATENCY_SERIES: SeriesSpec[] = [
  { key: "p50Ms", label: "p50", color: "var(--series-1)", format: formatDuration },
  { key: "p95Ms", label: "p95", color: "var(--series-2)", format: formatDuration },
];

export function LatencyChart({ data }: { data: DailyDatum[] }) {
  return (
    <ChartCard title="Run latency" subtitle="End-to-end duration per day" legend={<Legend series={LATENCY_SERIES} />}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="day" tickFormatter={dayTick} {...axisProps} minTickGap={16} />
          <YAxis tickFormatter={formatTick} {...axisProps} width={52} />
          <Tooltip cursor={{ stroke: "var(--border-strong)" }} content={(p) => <ChartTooltip {...p} series={LATENCY_SERIES} />} />
          {LATENCY_SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
