"use client";

import { GitCompareArrows, X } from "lucide-react";
import Link from "next/link";
import { createContext, use, useState, type ReactNode } from "react";

export interface SelectableRun {
  traceId: string;
  name: string;
  startTime: string;
}

interface SelectionState {
  selected: SelectableRun[];
  toggle: (run: SelectableRun) => void;
}

const SelectionContext = createContext<SelectionState | null>(null);

export const MAX_COMPARE = 2;

/** Holds the run list's checkbox selection and shows the compare bar once something is picked. */
export function RunSelection({ comparePath, children }: { comparePath: string; children: ReactNode }) {
  const [selected, setSelected] = useState<SelectableRun[]>([]);
  const toggle = (run: SelectableRun) =>
    setSelected((prev) =>
      prev.some((r) => r.traceId === run.traceId)
        ? prev.filter((r) => r.traceId !== run.traceId)
        : prev.length < MAX_COMPARE
          ? [...prev, run]
          : prev,
    );

  // The older run is the baseline (A), so the diff reads as "what changed since".
  const [a, b] = [...selected].sort((x, y) => x.startTime.localeCompare(y.startTime));

  return (
    <SelectionContext value={{ selected, toggle }}>
      {children}
      {selected.length > 0 && (
        <div
          role="region"
          aria-label="Compare selection"
          className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-[13px] shadow-[0_12px_40px_-12px_rgb(0_0_0/0.6)]"
        >
          <span className="text-fg-muted">
            {selected.length === 1 ? "1 run selected. Pick one more to compare." : "2 runs selected"}
          </span>
          {a && b ? (
            <Link
              href={`${comparePath}?a=${a.traceId}&b=${b.traceId}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 font-semibold text-accent-fg hover:bg-accent-hover"
            >
              <GitCompareArrows className="size-4" aria-hidden />
              Compare
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setSelected([])}
            aria-label="Clear selection"
            className="inline-flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </SelectionContext>
  );
}

export function RunSelectCheckbox({ run }: { run: SelectableRun }) {
  const ctx = use(SelectionContext);
  if (!ctx) return null;
  const checked = ctx.selected.some((r) => r.traceId === run.traceId);
  const full = ctx.selected.length >= MAX_COMPARE && !checked;
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={full}
      onChange={() => ctx.toggle(run)}
      aria-label={`Select ${run.name} to compare`}
      title={full ? "Two runs are already selected" : "Select to compare"}
      // Sits above the row's stretched link so clicking it doesn't navigate.
      className="relative z-10 size-3.5 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}
