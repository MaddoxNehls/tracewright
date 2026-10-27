import type { DiffSummary } from "@tracewright/run-diff";
import { ArrowRight } from "lucide-react";
import { formatCost, formatDuration, formatRatio, formatSigned, formatTokens } from "@/lib/format";
import { StatusBadge } from "../status";

interface Metric {
  label: string;
  left: number | null;
  right: number | null;
  delta: number | null;
  format: (v: number | null) => string;
  /** Lower is better (cost, tokens, latency): color the delta. Call counts stay neutral. */
  judged: boolean;
}

/** The headline numbers of a comparison: B minus A for each run-level total. */
export function CompareSummary({ summary }: { summary: DiffSummary }) {
  const { left, right, delta } = summary;
  const metrics: Metric[] = [
    { label: "Cost", left: left.costUsd, right: right.costUsd, delta: delta.costUsd, format: formatCost, judged: true },
    { label: "Tokens", left: left.totalTokens, right: right.totalTokens, delta: delta.totalTokens, format: formatTokens, judged: true },
    { label: "Duration", left: left.durationMs, right: right.durationMs, delta: delta.durationMs, format: formatDuration, judged: true },
    { label: "LLM calls", left: left.llmCalls, right: right.llmCalls, delta: delta.llmCalls, format: (v) => String(v ?? "–"), judged: false },
    { label: "Tool calls", left: left.toolCalls, right: right.toolCalls, delta: delta.toolCalls, format: (v) => String(v ?? "–"), judged: false },
  ];

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 xl:grid-cols-6" data-testid="compare-summary">
      <div className="bg-surface px-4 py-3">
        <dt className="text-[12px] text-fg-subtle">Status</dt>
        <dd className="mt-1.5 flex items-center gap-2">
          <StatusBadge status={left.status} size="md" />
          <ArrowRight className="size-3.5 text-fg-subtle" aria-label="to" />
          <StatusBadge status={right.status} size="md" />
        </dd>
        <dd className="mt-0.5 text-[12px] text-fg-muted">{summary.statusChanged ? (right.status === "ok" ? "Fixed in B" : "Broken in B") : "Unchanged"}</dd>
      </div>
      {metrics.map((m) => (
        <div key={m.label} className="bg-surface px-4 py-3">
          <dt className="text-[12px] text-fg-subtle">{m.label}</dt>
          <dd className="tabular mt-1 text-[20px] font-semibold tracking-tight text-fg">{m.format(m.right)}</dd>
          <dd className="tabular text-[12px] text-fg-muted">
            <Delta metric={m} /> <span className="text-fg-subtle">vs {m.format(m.left)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Delta({ metric }: { metric: Metric }) {
  const { delta, left, judged, format } = metric;
  if (delta === null) return <span>no data</span>;
  if (delta === 0) return <span>no change</span>;
  const tone = !judged ? "text-fg" : delta > 0 ? "text-err" : "text-ok";
  const ratio = formatRatio(delta, left);
  return (
    <span className={`font-medium ${tone}`}>
      {formatSigned(delta, (v) => format(v))}
      {ratio && ` (${ratio})`}
    </span>
  );
}
