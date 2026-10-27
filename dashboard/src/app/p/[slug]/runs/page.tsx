import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeading } from "@/components/page-heading";
import { RunFilters } from "@/components/runs/run-filters";
import { RunListSkeleton } from "@/components/runs/run-list-skeleton";
import { RunTable } from "@/components/runs/run-table";
import { hasActiveFilters, parseRunListParams, runListQueryString } from "@/lib/run-list-params";
import { getVisibleProject } from "@/server/projects";
import { getRunFacets, listRuns } from "@/server/runs";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage({ params, searchParams }: PageProps<"/p/[slug]/runs">) {
  return (
    <>
      <PageHeading title="Runs" description="Every recorded agent run, newest first. Filters and sort live in the URL, so any view can be shared." />
      <Suspense fallback={<RunListSkeleton />}>
        <RunList params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function RunList({
  params,
  searchParams,
}: {
  params: PageProps<"/p/[slug]/runs">["params"];
  searchParams: PageProps<"/p/[slug]/runs">["searchParams"];
}) {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);
  const project = await getVisibleProject(slug);
  if (!project) notFound();

  const listParams = parseRunListParams(raw);
  const basePath = `/p/${project.slug}/runs`;
  const [page, facets] = await Promise.all([listRuns(project.id, listParams), getRunFacets(project.id)]);

  return (
    <div className="flex flex-col gap-3">
      <RunFilters basePath={basePath} params={listParams} models={facets.models} tags={facets.tags} />

      {page.runs.length === 0 ? (
        hasActiveFilters(listParams) || listParams.cursor ? (
          <EmptyState
            title="No runs match these filters"
            body="Try a different status, model, or tag, or search for part of a run name."
            action={
              <Link href={basePath} className="text-[13px] font-medium text-accent hover:underline">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No runs recorded yet"
            body="Point an SDK at this project's ingest endpoint. Runs appear here as soon as their spans are written."
            code={`from tracewright import trace\n\n@trace(kind="agent")\ndef research(question: str) -> str:\n    ...`}
          />
        )
      ) : (
        <>
          <RunTable basePath={basePath} params={listParams} runs={page.runs} />
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-[13px] text-fg-muted">
            <span className="tabular">
              {page.runs.length} {page.runs.length === 1 ? "run" : "runs"} on this page
            </span>
            <div className="flex items-center gap-2">
              {listParams.cursor && (
                <Link href={`${basePath}${runListQueryString(listParams)}`} className={pagerClass}>
                  First page
                </Link>
              )}
              {page.nextCursor && (
                <Link href={`${basePath}${runListQueryString(listParams, { cursor: page.nextCursor })}`} className={pagerClass}>
                  Next page
                </Link>
              )}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}

const pagerClass =
  "inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 font-medium text-fg hover:bg-surface-2";
