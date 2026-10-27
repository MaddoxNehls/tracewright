import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { CostPerDayChart, LatencyChart, RunsPerDayChart, type DailyDatum } from "@/components/overview/charts";
import { ModelBreakdownCard } from "@/components/overview/model-breakdown";
import { OverviewSkeleton } from "@/components/overview/overview-skeleton";
import { PageHeading } from "@/components/page-heading";
import { StatusBadge } from "@/components/status";
import { formatCost, formatDateTime, formatDay, formatDuration, formatPercent, formatTokens } from "@/lib/format";
import { DEFAULT_RUN_LIST_PARAMS } from "@/lib/run-list-params";
import { getOverview } from "@/server/overview";
import { getVisibleProject } from "@/server/projects";
import { listRuns } from "@/server/runs";

export const metadata: Metadata = { title: "Overview" };

const WINDOW_DAYS = 14;

export default function OverviewPage({ params }: PageProps<"/p/[slug]">) {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewBody params={params} />
    </Suspense>
  );
}

async function OverviewBody({ params }: { params: PageProps<"/p/[slug]">["params"] }) {
  const { slug } = await params;
  const project = await getVisibleProject(slug);
  if (!project) notFound();

  const [overview, failures] = await Promise.all([
    getOverview(project.id, WINDOW_DAYS),
    listRuns(project.id, { ...DEFAULT_RUN_LIST_PARAMS, status: "error" }, 5),
  ]);
  const { totals } = overview;
  const runsHref = `/p/${project.slug}/runs`;
  const lastDay = new Date(new Date(totals.windowEnd).getTime() - 86_400_000).toISOString();

  const heading = (
    <PageHeading
      title="Overview"
      description={`${WINDOW_DAYS} days of activity through ${formatDay(lastDay)} (UTC), ending at the most recent run.`}
    >
      <Link
        href={runsHref}
        className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
      >
        View all runs
      </Link>
    </PageHeading>
  );

  if (totals.runs === 0) {
    return (
      <>
        {heading}
        <EmptyState
          title="No runs in this project yet"
          body="Once an agent sends spans to this project, cost, latency, and status trends show up here."
        />
      </>
    );
  }

  const daily: DailyDatum[] = overview.daily.map((d) => ({
    day: d.day,
    ok: d.runs - d.errors,
    errors: d.errors,
    costUsd: d.costUsd,
    p50Ms: d.p50Ms,
    p95Ms: d.p95Ms,
  }));

  const kpis: { label: string; value: string; sub?: string }[] = [
    { label: "Runs", value: String(totals.runs) },
    { label: "Error rate", value: formatPercent(totals.errors / totals.runs), sub: `${totals.errors} failed` },
    { label: "Total cost", value: formatCost(totals.costUsd), sub: `${formatCost(totals.costUsd / totals.runs)} per run` },
    { label: "Tokens", value: formatTokens(totals.tokens) },
    { label: "p50 latency", value: formatDuration(totals.p50Ms) },
    { label: "p95 latency", value: formatDuration(totals.p95Ms) },
  ];

  return (
    <>
      {heading}
      <dl className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="bg-surface px-4 py-3.5">
            <dt className="text-[12px] text-fg-subtle">{k.label}</dt>
            <dd className="tabular mt-1 text-[22px] font-semibold tracking-tight text-fg">{k.value}</dd>
            {k.sub && <dd className="tabular text-[12px] text-fg-muted">{k.sub}</dd>}
          </div>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <RunsPerDayChart data={daily} />
        <CostPerDayChart data={daily} />
        <LatencyChart data={daily} />
        <ModelBreakdownCard models={overview.models} />
      </div>

      <section className="mt-4 rounded-lg border border-border bg-surface" aria-label="Recent failures">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-semibold text-fg">Recent failures</h2>
          <Link href={`${runsHref}?status=error`} className="text-[12.5px] font-medium text-fg-muted hover:text-fg">
            All failed runs
          </Link>
        </div>
        {failures.runs.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-fg-muted">No failed runs. Every run in this project finished cleanly.</p>
        ) : (
          <ul>
            {failures.runs.map((r) => (
              <li key={r.traceId} className="border-b border-border last:border-b-0">
                <Link
                  href={`${runsHref}/${r.traceId}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-surface-2"
                >
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{r.name}</span>
                  <span className="tabular text-[12.5px] text-fg-muted">{formatDuration(r.durationMs)}</span>
                  <span className="tabular w-36 text-right text-[12.5px] text-fg-subtle">{formatDateTime(r.startTime)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
