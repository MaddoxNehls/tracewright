import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { formatCost, formatDateTime, formatDuration, formatTokens, shortId, shortModel } from "@/lib/format";
import { runListQueryString, type RunListParams, type SortKey } from "@/lib/run-list-params";
import type { RunSummary } from "@/lib/types";
import { Chip } from "../chip";
import { StatusBadge } from "../status";
import { RunSelectCheckbox } from "./run-selection";

interface Props {
  basePath: string;
  params: RunListParams;
  runs: RunSummary[];
  /** Show a checkbox column for picking runs to compare (needs a surrounding <RunSelection>). */
  selectable?: boolean;
}

export function RunTable({ basePath, params, runs, selectable = false }: Props) {
  const maxDuration = Math.max(...runs.map((r) => r.durationMs), 1);

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[1340px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-fg-subtle">
            {selectable && (
              <th className="w-9 pl-4">
                <span className="sr-only">Select</span>
              </th>
            )}
            <Th className={`w-[84px] ${selectable ? "pl-2" : "pl-4"}`}>Status</Th>
            <Th>Run</Th>
            <SortTh basePath={basePath} params={params} sortKey="started" className="w-[150px]">
              Started
            </SortTh>
            <SortTh basePath={basePath} params={params} sortKey="duration" className="w-[150px]">
              Duration
            </SortTh>
            <Th className="w-[56px] text-right">LLM</Th>
            <Th className="w-[56px] text-right">Tools</Th>
            <SortTh basePath={basePath} params={params} sortKey="tokens" className="w-[84px]" align="right">
              Tokens
            </SortTh>
            <SortTh basePath={basePath} params={params} sortKey="cost" className="w-[84px]" align="right">
              Cost
            </SortTh>
            <Th className="w-[260px] pl-5">Models</Th>
            <Th className="w-[180px] pr-4">Tags</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.traceId}
              className="relative border-b border-border transition-colors last:border-b-0 hover:bg-surface-2 focus-within:bg-surface-2"
            >
              {selectable && (
                <td className="py-2.5 pl-4 align-top">
                  <span className="flex h-[18px] items-center">
                    <RunSelectCheckbox run={{ traceId: run.traceId, name: run.name, startTime: run.startTime }} />
                  </span>
                </td>
              )}
              <td className={`py-2.5 pr-3 align-top ${selectable ? "pl-2" : "pl-4"}`}>
                <StatusBadge status={run.status} />
              </td>
              <td className="max-w-0 py-2.5 pr-3 align-top">
                <Link
                  href={`${basePath}/${run.traceId}`}
                  className="block truncate font-medium text-fg outline-none after:absolute after:inset-0 after:content-['']"
                  title={run.name}
                >
                  {run.name}
                </Link>
                <span className="font-mono text-[11px] text-fg-subtle">{shortId(run.traceId, 12)}</span>
              </td>
              <td className="tabular py-2.5 pr-3 align-top text-fg-muted" title={run.startTime}>
                {formatDateTime(run.startTime)}
              </td>
              <td className="py-2.5 pr-3 align-top">
                <span className="tabular text-fg">{formatDuration(run.durationMs)}</span>
                <span className="mt-1.5 block h-[3px] w-full max-w-[110px] rounded-full bg-surface-3" aria-hidden>
                  <span
                    className={`block h-full rounded-full ${run.status === "error" ? "bg-err" : "bg-kind-llm"}`}
                    style={{ width: `${Math.max((run.durationMs / maxDuration) * 100, 2)}%` }}
                  />
                </span>
              </td>
              <td className="tabular py-2.5 pr-3 text-right align-top text-fg-muted">{run.llmCallCount}</td>
              <td className="tabular py-2.5 pr-3 text-right align-top text-fg-muted">{run.toolCallCount}</td>
              <td
                className="tabular py-2.5 pr-3 text-right align-top text-fg-muted"
                title={`${run.inputTokens.toLocaleString("en-US")} in, ${run.outputTokens.toLocaleString("en-US")} out`}
              >
                {formatTokens(run.inputTokens + run.outputTokens)}
              </td>
              <td className="tabular py-2.5 pr-3 text-right align-top text-fg">{formatCost(run.costUsd)}</td>
              <td className="py-2.5 pl-5 pr-3 align-top">
                <div className="flex flex-wrap gap-1">
                  {run.models.map((m) => (
                    <Chip key={m} title={m}>
                      {shortModel(m)}
                    </Chip>
                  ))}
                </div>
              </td>
              <td className="py-2.5 pr-4 align-top">
                <div className="flex flex-wrap gap-1">
                  {run.tags.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`h-9 pr-3 font-medium ${className}`}>{children}</th>;
}

function SortTh({
  basePath,
  params,
  sortKey,
  children,
  className = "",
  align = "left",
}: {
  basePath: string;
  params: RunListParams;
  sortKey: SortKey;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const active = params.sort === sortKey;
  // First click sorts descending (largest / newest first); clicking again flips.
  const nextDir = active && params.dir === "desc" ? "asc" : "desc";
  const Arrow = params.dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <th
      className={`h-9 pr-3 font-medium ${align === "right" ? "text-right" : ""} ${className}`}
      aria-sort={active ? (params.dir === "desc" ? "descending" : "ascending") : "none"}
    >
      <Link
        href={`${basePath}${runListQueryString(params, { sort: sortKey, dir: nextDir })}`}
        scroll={false}
        className={`inline-flex items-center gap-1 rounded hover:text-fg ${active ? "text-fg" : ""}`}
      >
        {children}
        {active && <Arrow className="size-3" aria-hidden />}
      </Link>
    </th>
  );
}
