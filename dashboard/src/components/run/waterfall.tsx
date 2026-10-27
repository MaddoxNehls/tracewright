"use client";

import { ChevronRight, CircleAlert } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { formatDuration, formatTick } from "@/lib/format";
import { KIND_BG, KIND_LABEL } from "@/lib/kinds";
import { SPAN_KINDS, type Span } from "@/lib/types";
import type { TraceWindow, WaterfallRow } from "@/lib/waterfall";

export const rowDomId = (spanId: string) => `span-row-${spanId}`;

interface Props {
  rows: WaterfallRow<Span>[];
  timeWindow: TraceWindow;
  ticks: number[];
  selectedId?: string | null;
  onSelect?: (spanId: string) => void;
  onToggle?: (spanId: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  treeRef?: Ref<HTMLDivElement>;
  /** Animate bars in on first paint (used by the landing hero). */
  reveal?: boolean;
  label?: string;
}

const INDENT = 14;
/** Bars stop short of the right edge so a duration label always fits after even a full-width bar. */
const TRACK_INSET = "right-14";

export function Waterfall({ rows, timeWindow, ticks, selectedId, onSelect, onToggle, onKeyDown, treeRef, reveal, label = "Span tree" }: Props) {
  const interactive = Boolean(onSelect);

  return (
    <div className="[--label-w:168px] sm:[--label-w:300px]">
      {/* Axis */}
      <div className="grid grid-cols-[var(--label-w)_1fr] border-b border-border text-[11px] text-fg-subtle">
        <div className="flex h-8 items-center gap-3 px-3">
          <span className="font-medium">Span</span>
        </div>
        <div className="relative h-8">
          <div className={`absolute inset-y-0 left-0 ${TRACK_INSET}`}>
            {ticks.map((t) => {
              const left = (t / timeWindow.totalMs) * 100;
              if (left > 100) return null;
              return (
                <span
                  key={t}
                  className="tabular absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
                  style={{ left: `${left}%`, transform: `translate(${t === 0 ? "0" : "-50%"}, -50%)` }}
                >
                  {formatTick(t)}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Rows */}
      <div
        ref={treeRef}
        role={interactive ? "tree" : "list"}
        aria-label={label}
        aria-activedescendant={interactive && selectedId ? rowDomId(selectedId) : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={onKeyDown}
        className="relative outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        {/* Tick gridlines behind every row */}
        <div className="pointer-events-none absolute inset-y-0 left-[var(--label-w)] right-0" aria-hidden>
          <div className={`absolute inset-y-0 left-0 ${TRACK_INSET}`}>
            {ticks.map((t) => (
              <span key={t} className="absolute inset-y-0 w-px bg-border/70" style={{ left: `${(t / timeWindow.totalMs) * 100}%` }} />
            ))}
          </div>
        </div>

        {rows.map((row, i) => (
          <Row
            key={row.span.spanId}
            row={row}
            index={i}
            selected={row.span.spanId === selectedId}
            interactive={interactive}
            onSelect={onSelect}
            onToggle={onToggle}
            reveal={reveal}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  row,
  index,
  selected,
  interactive,
  onSelect,
  onToggle,
  reveal,
}: {
  row: WaterfallRow<Span>;
  index: number;
  selected: boolean;
  interactive: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  reveal?: boolean;
}) {
  const { span, depth, hasChildren, collapsed, offsetPct, widthPct } = row;
  const isError = span.status === "error";

  return (
    <div
      id={rowDomId(span.spanId)}
      role={interactive ? "treeitem" : "listitem"}
      aria-level={interactive ? depth + 1 : undefined}
      aria-selected={interactive ? selected : undefined}
      aria-expanded={interactive && hasChildren ? !collapsed : undefined}
      aria-label={`${span.name}, ${KIND_LABEL[span.kind]}, ${formatDuration(span.durationMs)}${isError ? ", error" : ""}`}
      data-span-id={span.spanId}
      onClick={interactive ? () => onSelect?.(span.spanId) : undefined}
      className={`group relative grid h-[30px] grid-cols-[var(--label-w)_1fr] ${interactive ? "cursor-pointer" : ""} ${
        selected ? "bg-accent-soft" : interactive ? "hover:bg-surface-2" : ""
      }`}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}

      {/* Label column */}
      <div className="relative flex min-w-0 items-center gap-1.5 pr-2" style={{ paddingLeft: 8 + depth * INDENT }}>
        {Array.from({ length: depth }, (_, d) => (
          <span key={d} className="absolute inset-y-0 w-px bg-border" style={{ left: 8 + d * INDENT + 7 }} aria-hidden />
        ))}
        {hasChildren && interactive ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={collapsed ? `Expand ${span.name}` : `Collapse ${span.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.(span.spanId);
            }}
            className="relative z-10 -ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <ChevronRight className={`size-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} aria-hidden />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <span className={`size-2 shrink-0 rounded-[2px] ${KIND_BG[span.kind]}`} aria-hidden />
        <span className={`truncate text-[12.5px] ${span.kind === "custom" ? "text-fg-muted" : "text-fg"}`} title={span.name}>
          {span.name}
        </span>
        {isError && <CircleAlert className="size-3.5 shrink-0 text-err" aria-label="error" />}
      </div>

      {/* Track */}
      <div className="relative">
        <div className={`absolute inset-y-0 left-0 ${TRACK_INSET}`}>
          <span
            className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-[3px] ${isError ? "bar-error" : KIND_BG[span.kind]} ${
              selected ? "ring-2 ring-fg/70 ring-offset-1 ring-offset-surface" : ""
            } ${reveal ? "reveal-bar" : ""}`}
            style={{
              left: `${offsetPct}%`,
              width: `${widthPct}%`,
              minWidth: 2,
              animationDelay: reveal ? `${index * 35}ms` : undefined,
            }}
            aria-hidden
          />
          <span
            className={`tabular absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] ${isError ? "text-err" : "text-fg-subtle"}`}
            style={{ left: `calc(${offsetPct + widthPct}% + 6px)` }}
            aria-hidden
          >
            {formatDuration(span.durationMs)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function KindLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-fg-muted" aria-label="Legend">
      {SPAN_KINDS.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-[2px] ${KIND_BG[k]}`} aria-hidden />
          {KIND_LABEL[k]}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="bar-error h-2 w-3.5 rounded-[2px]" aria-hidden />
        Error
      </li>
    </ul>
  );
}
