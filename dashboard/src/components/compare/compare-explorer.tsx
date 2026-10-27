"use client";

import type { DiffRow, Divergence, RunDiff } from "@tracewright/run-diff";
import { CircleCheck, Crosshair } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DiffInspector } from "./diff-inspector";
import { visibleRowIndexes } from "@/lib/diff-rows";
import { DiffTree, diffRowDomId } from "./diff-tree";

interface Props {
  diff: RunDiff;
  labels: { a: string; b: string };
  replayPair: boolean;
}

const REASON_TEXT: Record<string, string> = {
  added: "a step only run B took",
  removed: "a step only run A took",
  model: "a different model",
  input: "different input",
  output: "different output",
  status: "a different status",
  error: "a different error",
  tokens: "a token count past the noise threshold",
  cost: "a cost past the noise threshold",
  latency: "a latency past the noise threshold",
  presence: "a span missing from the recording",
};

function describeDivergence(d: Divergence): string {
  const reasons = d.reasons.map((r) => REASON_TEXT[r] ?? r);
  const list = reasons.length > 1 ? `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}` : (reasons[0] ?? "");
  if (d.reasons.includes("added") || d.reasons.includes("removed")) return `The runs part ways here: ${list}.`;
  return d.phase === "enter" ? `Before this step ran, it already had ${list}.` : `This step produced ${list}.`;
}

/** Side-by-side diff: first divergence, aligned tree, and the inspector for the selected step. */
export function CompareExplorer({ diff, labels, replayPair }: Props) {
  const { rows, firstDivergence } = diff;
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [selected, setSelected] = useState<number>(() => firstDivergence?.rowIndex ?? 0);
  const [flash, setFlash] = useState<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  // A newly selected row starts at the top of the inspector, not wherever the last one was scrolled.
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [selected]);
  const visible = useMemo(() => visibleRowIndexes(rows, onlyChanges), [rows, onlyChanges]);

  const select = useCallback((i: number) => {
    setSelected(i);
    document.getElementById(diffRowDomId(i))?.scrollIntoView({ block: "nearest" });
  }, []);

  const jumpToDivergence = () => {
    if (!firstDivergence) return;
    select(firstDivergence.rowIndex);
    document.getElementById(diffRowDomId(firstDivergence.rowIndex))?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(null);
    requestAnimationFrame(() => setFlash(firstDivergence.rowIndex));
    treeRef.current?.focus({ preventScroll: true });
  };

  const move = useCallback(
    (step: number) => {
      const pos = visible.indexOf(selected);
      const next = visible[Math.min(Math.max((pos === -1 ? 0 : pos) + step, 0), visible.length - 1)];
      if (next !== undefined) select(next);
    },
    [visible, selected, select],
  );

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "j") move(1);
    else if (e.key === "ArrowUp" || e.key === "k") move(-1);
    else return;
    e.preventDefault();
  };

  // j / k from anywhere on the page, except while typing.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !["j", "k"].includes(e.key)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']") || treeRef.current?.contains(target)) return;
      move(e.key === "j" ? 1 : -1);
      e.preventDefault();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [move]);

  const row: DiffRow | undefined = rows[selected];
  const divergenceRow = firstDivergence ? rows[firstDivergence.rowIndex] : undefined;

  return (
    <div className="flex flex-col gap-4">
      {firstDivergence && divergenceRow ? (
        <section
          aria-label="First divergence"
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3.5"
          data-testid="first-divergence"
        >
          <div className="flex min-w-0 items-start gap-3">
            <Crosshair className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-fg">
                First divergence at row {firstDivergence.rowIndex + 1}:{" "}
                <span className="font-mono text-[12.5px]">{divergenceRow.right?.name ?? divergenceRow.left?.name}</span>
              </h2>
              <p className="mt-0.5 text-[13px] text-fg-muted">{describeDivergence(firstDivergence)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={jumpToDivergence}
            className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:bg-accent-hover"
          >
            Jump to this row
          </button>
        </section>
      ) : (
        <section aria-label="First divergence" className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3.5" data-testid="first-divergence">
          <CircleCheck className="size-5 shrink-0 text-ok" aria-hidden />
          <p className="text-[13px] text-fg-muted">
            <span className="font-medium text-fg">No divergence.</span> Both runs took the same steps with the same models, inputs, outputs and statuses.
          </p>
        </section>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <section aria-label="Aligned steps" className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2 text-[11.5px] text-fg-muted">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Legend">
              <LegendItem glyph="~" tone="text-warn" label={`Modified (${diff.summary.rows.modified})`} />
              <LegendItem glyph="+" tone="text-ok" label={`Added in B (${diff.summary.rows.added})`} />
              <LegendItem glyph={"−"} tone="text-err" label={`Removed in B (${diff.summary.rows.removed})`} />
              <li className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-warn/70" aria-hidden />
                Changed inside
              </li>
            </ul>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} className="accent-[var(--accent)]" />
              Only changed steps
            </label>
          </div>
          <div className="max-h-[70dvh] overflow-y-auto">
            <DiffTree
              rows={rows}
              visible={visible}
              firstDivergence={firstDivergence}
              labels={labels}
              selected={selected}
              onSelect={(i) => {
                select(i);
                treeRef.current?.focus({ preventScroll: true });
              }}
              onKeyDown={onTreeKeyDown}
              treeRef={treeRef}
              flashIndex={flash}
            />
          </div>
        </section>

        <aside ref={inspectorRef} className="min-w-0 rounded-lg border border-border bg-surface lg:sticky lg:top-[72px] lg:max-h-[calc(100dvh-88px)] lg:overflow-y-auto">
          {row ? <DiffInspector key={selected} row={row} index={selected} replayPair={replayPair} /> : null}
        </aside>
      </div>
    </div>
  );
}

function LegendItem({ glyph, tone, label }: { glyph: string; tone: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={`font-mono text-[13px] font-semibold ${tone}`} aria-hidden>
        {glyph}
      </span>
      {label}
    </li>
  );
}
