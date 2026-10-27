"use client";

import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isReplayed } from "@/lib/replay";
import type { Span } from "@/lib/types";
import { ancestorPath, buildSpanTree, layoutWaterfall, timeTicks, traceWindow } from "@/lib/waterfall";
import { SpanInspector } from "./span-inspector";
import { KindLegend, rowDomId, Waterfall } from "./waterfall";

interface Props {
  spans: Span[];
  initialSpanId: string | null;
}

/**
 * Run detail body: the waterfall (which doubles as the collapsible span tree)
 * and the inspector for the selected span.
 *
 * Keys: j / ↓ next, k / ↑ previous, ← collapse or go to parent,
 * → expand or go to first child, Home / End jump.
 */
export function RunExplorer({ spans, initialSpanId }: Props) {
  const tree = useMemo(() => buildSpanTree(spans), [spans]);
  const traceWin = useMemo(() => traceWindow(spans), [spans]);
  const ticks = useMemo(() => timeTicks(traceWin.totalMs, 6), [traceWin.totalMs]);
  const byId = useMemo(() => new Map(spans.map((s) => [s.spanId, s])), [spans]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialSpanId && byId.has(initialSpanId) ? initialSpanId : (tree[0]?.span.spanId ?? null),
  );
  const rows = useMemo(() => layoutWaterfall(tree, traceWin, collapsed), [tree, traceWin, collapsed]);
  const treeRef = useRef<HTMLDivElement>(null);

  const select = useCallback((spanId: string) => {
    setSelectedId(spanId);
    // Keep the selection shareable without a server round trip.
    const url = new URL(globalThis.location.href);
    url.searchParams.set("span", spanId);
    globalThis.history.replaceState(globalThis.history.state, "", url);
  }, []);

  const toggle = useCallback(
    (spanId: string) => {
      const collapsing = !collapsed.has(spanId);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (collapsing) next.add(spanId);
        else next.delete(spanId);
        return next;
      });
      // Collapsing an ancestor of the selection moves the selection up to it.
      if (collapsing && selectedId && selectedId !== spanId && ancestorPath(spans, selectedId).includes(spanId)) select(spanId);
    },
    [collapsed, selectedId, spans, select],
  );

  const setAll = (collapse: boolean) => {
    if (!collapse) {
      setCollapsed(new Set());
      return;
    }
    const parents = new Set(spans.map((s) => s.parentSpanId).filter((id): id is string => id !== null && byId.has(id)));
    // Keep the top level open so the run's steps stay visible.
    for (const root of tree) parents.delete(root.span.spanId);
    setCollapsed(parents);
    const firstHidden = selectedId ? ancestorPath(spans, selectedId).find((id) => parents.has(id)) : undefined;
    if (firstHidden) select(firstHidden);
  };

  const handleKey = useCallback(
    (key: string): boolean => {
      const index = rows.findIndex((r) => r.span.spanId === selectedId);
      const row = rows[index];
      const go = (i: number) => {
        const target = rows[Math.min(Math.max(i, 0), rows.length - 1)];
        if (target) select(target.span.spanId);
      };
      switch (key) {
        case "j":
        case "ArrowDown":
          go(index + 1);
          return true;
        case "k":
        case "ArrowUp":
          go(index - 1);
          return true;
        case "Home":
          go(0);
          return true;
        case "End":
          go(rows.length - 1);
          return true;
        case "h":
        case "ArrowLeft":
          if (row?.hasChildren && !row.collapsed) toggle(row.span.spanId);
          else if (row?.span.parentSpanId && byId.has(row.span.parentSpanId)) select(row.span.parentSpanId);
          return true;
        case "l":
        case "ArrowRight":
          if (row?.hasChildren && row.collapsed) toggle(row.span.spanId);
          else if (row?.hasChildren) go(index + 1);
          return true;
        default:
          return false;
      }
    },
    [rows, selectedId, select, toggle, byId],
  );

  // Arrow keys, Home and End work while the tree has focus.
  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (handleKey(e.key)) e.preventDefault();
  };

  // j / k work from anywhere on the page, except while typing.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (!["j", "k"].includes(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (treeRef.current?.contains(target)) return; // handled by onTreeKeyDown
      if (handleKey(e.key)) e.preventDefault();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [handleKey]);

  useEffect(() => {
    if (selectedId) document.getElementById(rowDomId(selectedId))?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const selected = selectedId ? byId.get(selectedId) : undefined;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
      <section aria-label="Timeline" className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2">
          <KindLegend showReplayed={spans.some((s) => isReplayed(s.attributes))} />
          <div className="flex items-center gap-3">
            <span className="hidden text-[11.5px] text-fg-subtle xl:inline">
              <Kbd>j</Kbd> <Kbd>k</Kbd> to move, <Kbd>←</Kbd> <Kbd>→</Kbd> to fold
            </span>
            <button type="button" onClick={() => setAll(false)} className={toolbarButton} aria-label="Expand all spans">
              <ChevronsUpDown className="size-3.5" aria-hidden />
              Expand
            </button>
            <button type="button" onClick={() => setAll(true)} className={toolbarButton} aria-label="Collapse all spans">
              <ChevronsDownUp className="size-3.5" aria-hidden />
              Collapse
            </button>
          </div>
        </div>
        <div className="max-h-[70dvh] overflow-y-auto">
          <Waterfall
            rows={rows}
            timeWindow={traceWin}
            ticks={ticks}
            selectedId={selectedId}
            onSelect={(id) => {
              select(id);
              treeRef.current?.focus({ preventScroll: true });
            }}
            onToggle={toggle}
            onKeyDown={onTreeKeyDown}
            treeRef={treeRef}
          />
        </div>
      </section>

      <aside className="min-w-0 rounded-lg border border-border bg-surface lg:sticky lg:top-[72px] lg:max-h-[calc(100dvh-88px)] lg:overflow-y-auto">
        {selected ? (
          <SpanInspector key={selected.spanId} span={selected} offsetMs={new Date(selected.startTime).getTime() - traceWin.startMs} />
        ) : (
          <p className="p-6 text-[13px] text-fg-muted">Select a span to inspect it.</p>
        )}
      </aside>
    </div>
  );
}

const toolbarButton =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-fg-muted hover:bg-surface-2 hover:text-fg";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border-strong px-1 font-sans text-[10.5px] text-fg-muted">
      {children}
    </kbd>
  );
}
