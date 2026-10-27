import { formatCost } from "@/lib/format";
import type { ModelBreakdown } from "@/server/overview";
import { ChartCard } from "./charts";

/** Single-series horizontal bars as plain HTML: for a handful of categories this reads better than a chart. */
export function ModelBreakdownCard({ models }: { models: ModelBreakdown[] }) {
  const max = Math.max(...models.map((m) => m.runs), 1);
  return (
    <ChartCard title="Runs by model" subtitle="A run that used several models counts toward each">
      <table className="w-full text-[12.5px]">
        <thead className="text-left text-[11.5px] text-fg-subtle">
          <tr>
            <th className="pb-2 font-medium">Model</th>
            <th className="pb-2 font-medium">Runs</th>
            <th className="pb-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model}>
              <td className="w-[40%] max-w-0 truncate py-2 pr-3 text-fg" title={m.model}>
                {m.model}
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 min-w-[2px] rounded-r-[4px] bg-[var(--series-1)]"
                    style={{ width: `${(m.runs / max) * 65}%` }}
                    aria-hidden
                  />
                  <span className="tabular text-fg">{m.runs}</span>
                  {m.errors > 0 && <span className="tabular text-fg-subtle">{m.errors} failed</span>}
                </div>
              </td>
              <td className="tabular w-20 py-2 text-right text-fg-muted">{formatCost(m.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  );
}
