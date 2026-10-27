import { ArrowLeftRight, History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CompareExplorer } from "@/components/compare/compare-explorer";
import { CompareSummary } from "@/components/compare/compare-summary";
import { EmptyState } from "@/components/empty-state";
import { PageHeading } from "@/components/page-heading";
import { StatusBadge } from "@/components/status";
import { compareRuns } from "@/lib/compare";
import { formatDateTime, shortId } from "@/lib/format";
import { replayInfo } from "@/lib/replay";
import type { RunDetail } from "@/lib/types";
import { getVisibleProject } from "@/server/projects";
import { getRunDetail } from "@/server/runs";

export const metadata: Metadata = { title: "Compare runs" };

type Props = PageProps<"/p/[slug]/compare">;

export default function ComparePage({ params, searchParams }: Props) {
  return (
    <>
      <PageHeading
        title="Compare runs"
        description="Both runs' steps aligned side by side. Run A is the baseline; every change is read as A to B."
      />
      <Suspense fallback={<CompareSkeleton />}>
        <CompareBody params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const param = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);

async function CompareBody({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  // The layout already 404s on an unknown or private slug; this lookup is deduplicated.
  const project = await getVisibleProject(slug);
  if (!project) notFound();
  const projectPath = `/p/${project.slug}`;
  const a = param(sp.a);
  const b = param(sp.b);

  if (!a || !b) {
    return (
      <EmptyState
        title="Pick two runs to compare"
        body="Select two runs in the run list and choose Compare, or open a run and use Compare with…."
        action={
          <Link href={`${projectPath}/runs`} className="text-[13px] font-medium text-accent hover:underline">
            Go to the run list
          </Link>
        }
      />
    );
  }

  const [left, right] = await Promise.all([getRunDetail(project.id, a), getRunDetail(project.id, b)]);
  if (!left || !right) {
    const missing = [!left && a, !right && b].filter(Boolean).map((id) => shortId(String(id), 12));
    return (
      <EmptyState
        title={`Run ${missing.join(" and ")} not found`}
        body="Check the trace IDs in the URL. Both runs must belong to this project."
        action={
          <Link href={`${projectPath}/runs`} className="text-[13px] font-medium text-accent hover:underline">
            Go to the run list
          </Link>
        }
      />
    );
  }

  const { diff, replayPair } = compareRuns(
    { traceId: left.run.traceId, spans: left.spans },
    { traceId: right.run.traceId, spans: right.spans },
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <RunCard label="A" role="Baseline" detail={left} projectPath={projectPath} />
        <Link
          href={`${projectPath}/compare?a=${b}&b=${a}`}
          className="inline-flex items-center justify-center gap-1.5 self-center rounded-md border border-border-strong bg-surface px-3 py-2 text-[12.5px] font-medium text-fg-muted hover:bg-surface-2 hover:text-fg"
          title="Swap A and B"
        >
          <ArrowLeftRight className="size-4" aria-hidden />
          <span className="md:sr-only">Swap A and B</span>
        </Link>
        <RunCard label="B" role="Candidate" detail={right} projectPath={projectPath} replayOf={replayInfo(right.spans)?.of === a ? "A" : null} />
      </div>

      <CompareSummary summary={diff.summary} />

      {replayPair && (
        <p className="flex items-start gap-2 text-[12.5px] text-fg-muted">
          <History className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
          One run replays the other. Replayed steps are compared on what they did, not on their cost or latency, which only
          reflect serving the recording.
        </p>
      )}

      <CompareExplorer
        diff={diff}
        replayPair={replayPair}
        labels={{ a: `A  ${shortId(left.run.traceId, 12)}`, b: `B  ${shortId(right.run.traceId, 12)}` }}
      />
    </div>
  );
}

function RunCard({
  label,
  role,
  detail,
  projectPath,
  replayOf = null,
}: {
  label: string;
  role: string;
  detail: RunDetail;
  projectPath: string;
  replayOf?: string | null;
}) {
  const { run } = detail;
  return (
    <Link
      href={`${projectPath}/runs/${run.traceId}`}
      className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 hover:border-border-strong"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-[13px] font-semibold text-fg">{label}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-subtle">
          {role}
          {replayOf && (
            <span className="inline-flex items-center gap-1 rounded border border-border-strong px-1 text-fg-muted">
              <History className="size-3" aria-hidden />
              Replay of {replayOf}
            </span>
          )}
        </span>
        <span className="block truncate text-[14px] font-semibold text-fg">{run.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-fg-muted">
          <StatusBadge status={run.status} />
          <span className="tabular">{formatDateTime(run.startTime)}</span>
          <span className="font-mono text-[11px] text-fg-subtle">{shortId(run.traceId, 12)}</span>
        </span>
      </span>
    </Link>
  );
}

function CompareSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading comparison">
      <div className="grid gap-3 md:grid-cols-2">
        <span className="skeleton h-[74px]" />
        <span className="skeleton h-[74px]" />
      </div>
      <span className="skeleton h-[86px]" />
      <span className="skeleton h-14" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <span className="skeleton h-[420px]" />
        <span className="skeleton h-[420px]" />
      </div>
    </div>
  );
}
