"use client";

import { ChevronDown, GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { formatCost, formatDateTime, formatDuration, shortId } from "@/lib/format";
import type { RunStatus } from "@/lib/types";
import { StatusBadge } from "../status";

export interface CompareCandidate {
  traceId: string;
  status: RunStatus;
  startTime: string;
  durationMs: number;
  costUsd: number | null;
  tags: string[];
}

interface Props {
  comparePath: string;
  traceId: string;
  startTime: string;
  candidates: CompareCandidate[];
  runsHref: string;
}

/** "Compare with…": recent runs with the same name. The older run of the pair becomes the baseline (A). */
export function CompareMenu({ comparePath, traceId, startTime, candidates, runsHref }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hrefFor = (other: CompareCandidate) => {
    const [a, b] = other.startTime <= startTime ? [other.traceId, traceId] : [traceId, other.traceId];
    return `${comparePath}?a=${a}&b=${b}`;
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
      >
        <GitCompareArrows className="size-4" aria-hidden />
        Compare with…
        <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-40 mt-2 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-[0_20px_50px_-12px_rgb(0_0_0/0.6)]"
        >
          <div className="border-b border-border px-3 py-2 text-[12px] text-fg-subtle">Recent runs with the same name</div>
          {candidates.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-fg-muted">
              No other runs have this name yet. Select any two runs in the{" "}
              <Link href={runsHref} className="font-medium text-fg underline-offset-2 hover:underline">
                run list
              </Link>{" "}
              to compare them.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1" aria-label="Runs to compare with">
              {candidates.map((c) => (
                <li key={c.traceId}>
                  <Link href={hrefFor(c)} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2" onClick={() => setOpen(false)}>
                    <StatusBadge status={c.status} />
                    <span className="min-w-0 flex-1">
                      <span className="tabular block text-[13px] text-fg">{formatDateTime(c.startTime)}</span>
                      <span className="block truncate font-mono text-[11px] text-fg-subtle">
                        {shortId(c.traceId, 12)} {c.tags.length > 0 && <span className="font-sans">{c.tags.join(", ")}</span>}
                      </span>
                    </span>
                    <span className="tabular text-right text-[12px] text-fg-muted">
                      {formatDuration(c.durationMs)}
                      <span className="block">{formatCost(c.costUsd)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
