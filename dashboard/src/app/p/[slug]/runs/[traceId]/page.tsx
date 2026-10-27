import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Chip } from "@/components/chip";
import { CopyButton } from "@/components/copy-button";
import { RunDetailSkeleton } from "@/components/run/run-detail-skeleton";
import { RunExplorer } from "@/components/run/run-explorer";
import { StatusBadge } from "@/components/status";
import { formatCost, formatDateTime, formatDuration, formatTokens } from "@/lib/format";
import type { RunSummary } from "@/lib/types";
import { getVisibleProject } from "@/server/projects";
import { getRunDetail } from "@/server/runs";

export const metadata: Metadata = { title: "Run" };

type Props = PageProps<"/p/[slug]/runs/[traceId]">;

export default function RunPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<RunDetailSkeleton />}>
      <RunDetailView params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function RunDetailView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ slug, traceId }, sp] = await Promise.all([params, searchParams]);
  const project = await getVisibleProject(slug);
  if (!project) notFound();
  const detail = await getRunDetail(project.id, traceId);
  if (!detail) notFound();

  const span = typeof sp.span === "string" ? sp.span : null;
  return (
    <div className="flex flex-col gap-5">
      <RunHeader run={detail.run} runsHref={`/p/${project.slug}/runs`} />
      <RunExplorer spans={detail.spans} initialSpanId={span} />
    </div>
  );
}

function RunHeader({ run, runsHref }: { run: RunSummary; runsHref: string }) {
  const stats: { label: string; value: string; title?: string }[] = [
    { label: "Duration", value: formatDuration(run.durationMs) },
    { label: "Spans", value: String(run.spanCount) },
    { label: "LLM calls", value: String(run.llmCallCount) },
    { label: "Tool calls", value: String(run.toolCallCount) },
    {
      label: "Tokens",
      value: formatTokens(run.inputTokens + run.outputTokens),
      title: `${run.inputTokens.toLocaleString("en-US")} input, ${run.outputTokens.toLocaleString("en-US")} output`,
    },
    { label: "Cost", value: formatCost(run.costUsd) },
  ];

  return (
    <header className="flex flex-col gap-4">
      <Link href={runsHref} className="inline-flex w-fit items-center gap-1 text-[12.5px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden />
        All runs
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-fg">{run.name}</h1>
            <StatusBadge status={run.status} size="md" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-fg-muted">
            <span className="tabular">{formatDateTime(run.startTime)}</span>
            <span className="flex items-center gap-0.5 font-mono text-[11.5px] text-fg-subtle">
              {run.traceId}
              <CopyButton value={run.traceId} label="Copy trace ID" />
            </span>
          </div>
          {(run.models.length > 0 || run.tags.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {run.models.map((m) => (
                <Chip key={m} title="Model">
                  {m}
                </Chip>
              ))}
              {run.tags.map((t) => (
                <Chip key={t} title="Tag">
                  {t}
                </Chip>
              ))}
            </div>
          )}
        </div>
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-6">
          {stats.map((s) => (
            <div key={s.label} title={s.title}>
              <dt className="text-[11.5px] text-fg-subtle">{s.label}</dt>
              <dd className="tabular mt-0.5 text-[17px] font-medium text-fg">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}
