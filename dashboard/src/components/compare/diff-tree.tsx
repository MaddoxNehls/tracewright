"use client";

import type { DiffRow, Divergence, RowStatus, SpanRef } from "@tracewright/run-diff";
import { CircleAlert, CornerDownRight } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { formatCost, formatDuration } from "@/lib/format";
import { KIND_BG } from "@/lib/kinds";
import { isReplayed } from "@/lib/replay";
import { ReplayedMark } from "../run/waterfall";

export const diffRowDomId = (index: number) => `diff-row-${index}`;

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  same: "Unchanged",
  modified: "Modified",
  added: "Added in B",
  removed: "Removed in B",
};

const GUTTER: Record<RowStatus, { glyph: string; className: string }> = {
  same: { glyph: "", className: "" },
  modified: { glyph: "~", className: "text-warn" },
  added: { glyph: "+", className: "text-ok" },
  removed: { glyph: "−", className: "text-err" },
};

const ROW_BG: Record<RowStatus, string> = {
  same: "",
  modified: "bg-warn/[0.07]",
  added: "bg-ok/[0.08]",
  removed: "bg-err/[0.08]",
};

const INDENT = 14;

interface Props {
  rows: DiffRow[];
  visible: number[];
  firstDivergence: Divergence | null;
  labels: { a: string; b: string };
  selected?: number | null;
  onSelect?: (index: number) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  treeRef?: Ref<HTMLDivElement>;
  flashIndex?: number | null;
}

/** The two runs' span trees aligned side by side, one merged row per step. */
export function DiffTree({ rows, visible, firstDivergence, labels, selected, onSelect, onKeyDown, treeRef, flashIndex }: Props) {
  const interactive = Boolean(onSelect);
  return (
    <div>
      <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)] border-b border-border text-[11.5px] text-fg-subtle">
        <span />
        <span className="px-3 py-2 font-medium">{labels.a}</span>
        <span className="border-l border-border px-3 py-2 font-medium">{labels.b}</span>
      </div>
      <div
        ref={treeRef}
        role={interactive ? "listbox" : "list"}
        aria-label="Aligned steps"
        aria-activedescendant={interactive && selected != null ? diffRowDomId(selected) : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={onKeyDown}
        className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        {visible.map((i) => (
          <DiffTreeRow
            key={i}
            index={i}
            row={rows[i]!}
            isFirstDivergence={firstDivergence?.rowIndex === i}
            selected={selected === i}
            flash={flashIndex === i}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function DiffTreeRow({
  index,
  row,
  isFirstDivergence,
  selected,
  flash,
  onSelect,
}: {
  index: number;
  row: DiffRow;
  isFirstDivergence: boolean;
  selected: boolean;
  flash: boolean;
  onSelect?: (i: number) => void;
}) {
  const gutter = GUTTER[row.status];
  const changed = row.changes.filter((c) => c.significant).map((c) => c.field);
  const name = row.right?.name ?? row.left?.name ?? "";
  const interactive = Boolean(onSelect);

  return (
    <div
      id={diffRowDomId(index)}
      role={interactive ? "option" : "listitem"}
      aria-selected={interactive ? selected : undefined}
      aria-label={`${name}: ${ROW_STATUS_LABEL[row.status]}${changed.length ? ` (${changed.join(", ")})` : ""}`}
      data-row-index={index}
      data-status={row.status}
      onClick={interactive ? () => onSelect?.(index) : undefined}
      className={`relative grid min-h-[30px] grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)] border-b border-border/60 last:border-b-0 ${ROW_BG[row.status]} ${
        interactive ? "cursor-pointer" : ""
      } ${selected ? "!bg-accent-soft" : interactive ? "hover:bg-surface-2" : ""} ${flash ? "flash-row" : ""}`}
    >
      {(selected || isFirstDivergence) && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      <span className={`flex items-center justify-center font-mono text-[13px] font-semibold ${gutter.className}`} aria-hidden>
        {gutter.glyph ||
          (row.descendantsChanged ? (
            <span className="size-1.5 rounded-full bg-warn/70" title="Something inside this step changed" />
          ) : null)}
      </span>
      <Side span={row.left} depth={row.depth} />
      <div className="relative min-w-0 border-l border-border/60">
        <Side span={row.right} depth={row.depth} />
        {(isFirstDivergence || changed.length > 0 || row.movedFrom !== undefined || row.movedTo !== undefined) && (
          <div className="flex flex-wrap items-center gap-1 pb-1.5 pr-2" style={{ paddingLeft: 30 + row.depth * INDENT }}>
            {isFirstDivergence && (
              <span className="rounded bg-accent px-1.5 py-px text-[10.5px] font-semibold text-accent-fg">First divergence</span>
            )}
            {row.status === "modified" &&
              changed.map((f) => (
                <span key={f} className="rounded border border-warn/40 px-1 text-[10.5px] text-warn">
                  {f}
                </span>
              ))}
            {(row.movedFrom !== undefined || row.movedTo !== undefined) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect?.((row.movedFrom ?? row.movedTo)!);
                }}
                className="inline-flex items-center gap-0.5 rounded border border-border-strong px-1 text-[10.5px] text-fg-muted hover:text-fg"
                title="The same step, with an identical subtree, appears elsewhere in the other run"
              >
                <CornerDownRight className="size-3" aria-hidden />
                moved {row.movedFrom !== undefined ? "from" : "to"} row {(row.movedFrom ?? row.movedTo)! + 1}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Side({ span, depth }: { span: SpanRef | undefined; depth: number }) {
  if (!span) return <span className="diff-absent block min-h-[30px]" aria-hidden />;
  const replayed = isReplayed(span.span.attributes);
  return (
    <div className="flex min-h-[30px] min-w-0 items-center gap-1.5 pr-2" style={{ paddingLeft: 10 + depth * INDENT }}>
      <span className={`size-2 shrink-0 rounded-[2px] ${KIND_BG[span.kind]}`} aria-hidden />
      <span className={`truncate text-[12.5px] ${span.kind === "custom" ? "text-fg-muted" : "text-fg"}`} title={span.name}>
        {span.name}
      </span>
      {span.status === "error" && <CircleAlert className="size-3.5 shrink-0 text-err" aria-label="error" />}
      {replayed && <ReplayedMark />}
      <span className="tabular ml-auto shrink-0 pl-2 text-[11px] text-fg-subtle">
        {formatDuration(span.durationMs)}
        {span.kind === "llm" && span.costUsd !== null && <span className="hidden pl-2 xl:inline">{formatCost(span.costUsd)}</span>}
      </span>
    </div>
  );
}
