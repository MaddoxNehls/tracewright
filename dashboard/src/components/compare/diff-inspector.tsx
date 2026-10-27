"use client";

import { diffPayload, type DiffRow, type FieldChange, type SpanRef, type TextGranularity } from "@tracewright/run-diff";
import { useMemo, useState } from "react";
import { formatCost, formatDuration, formatRatio, formatSigned, formatTokens } from "@/lib/format";
import { KIND_BG, KIND_LABEL } from "@/lib/kinds";
import { isReplayed } from "@/lib/replay";
import { ROW_STATUS_LABEL } from "./diff-tree";
import { HunkView, InlineDiffView } from "./text-diff";

type PayloadField = "input" | "output";

const FIELD_LABEL: Record<FieldChange["field"], string> = {
  presence: "Recorded",
  model: "Model",
  status: "Status",
  error: "Error",
  input: "Input",
  output: "Output",
  tokens: "Tokens",
  cost: "Cost",
  latency: "Latency",
};

const STATUS_TONE: Record<DiffRow["status"], string> = {
  same: "border-border-strong text-fg-muted",
  modified: "border-warn/50 text-warn",
  added: "border-ok/50 text-ok",
  removed: "border-err/50 text-err",
};

export function DiffInspector({ row, index, replayPair }: { row: DiffRow; index: number; replayPair: boolean }) {
  const kind = (row.right ?? row.left)!.kind;
  const changes = [...row.changes].sort((x, y) => Number(y.significant) - Number(x.significant));
  const payloadChanged = (f: PayloadField) => row.changes.some((c) => c.field === f) || !row.left || !row.right;
  const [field, setField] = useState<PayloadField>(() => (payloadChanged("output") || !payloadChanged("input") ? "output" : "input"));
  const [granularity, setGranularity] = useState<TextGranularity>("line");

  return (
    <section aria-label="Step comparison" className="flex flex-col" data-testid="diff-inspector">
      <header className="border-b border-border px-4 pb-3.5 pt-3.5">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5 font-medium text-fg-muted">
            <span className={`size-2 rounded-[2px] ${KIND_BG[kind]}`} aria-hidden />
            {KIND_LABEL[kind]}, row {index + 1}
          </span>
          <span className={`rounded border px-1.5 py-px text-[11px] font-medium ${STATUS_TONE[row.status]}`}>{ROW_STATUS_LABEL[row.status]}</span>
        </div>
        <h2 className="mt-1.5 break-words text-[15px] font-semibold leading-snug text-fg">{(row.right ?? row.left)!.name}</h2>
      </header>

      {/* Both sides of the step, column by column. */}
      <div className="grid grid-cols-2 border-b border-border">
        <SideFacts label="A" span={row.left} row={row} />
        <SideFacts label="B" span={row.right} row={row} border />
      </div>

      <div className="border-b border-border px-4 py-3.5">
        <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">What changed</h3>
        {changes.length === 0 ? (
          <p className="text-[13px] text-fg-muted">
            {row.status === "added" || row.status === "removed"
              ? `This step only exists in run ${row.status === "added" ? "B" : "A"}.`
              : "Nothing: same model, input, output and status."}
          </p>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="sr-only">
              <tr>
                <th>Field</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.field} className={c.significant ? "" : "opacity-55"} title={c.significant ? undefined : "Below the noise threshold"}>
                  <td className="w-24 py-1 pr-3 align-top text-fg-subtle">{FIELD_LABEL[c.field]}</td>
                  <td className="py-1 align-top text-fg">
                    <ChangeValue change={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {replayPair && (isReplayed(row.left?.span.attributes) || isReplayed(row.right?.span.attributes)) && (
          <p className="mt-2 text-[12px] text-fg-subtle">
            Served from the recording in the replay, so its cost and latency are not counted as changes.
          </p>
        )}
      </div>

      <div className="px-4 py-3.5">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="Payload" className="flex gap-1">
            {(["input", "output"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={field === f}
                onClick={() => setField(f)}
                className={`relative h-8 px-2 text-[12.5px] font-medium ${
                  field === f ? "text-fg after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-muted hover:text-fg"
                }`}
              >
                {f === "input" ? "Input diff" : "Output diff"}
                {payloadChanged(f) && <span className="ml-1 inline-block size-1.5 rounded-full bg-warn align-middle" aria-label="changed" />}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Diff granularity" className="inline-flex h-7 items-center rounded-md border border-border p-0.5 text-[12px]">
            {(["line", "word"] as const).map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={granularity === g}
                onClick={() => setGranularity(g)}
                className={`h-full rounded px-2 ${granularity === g ? "bg-surface-3 font-medium text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {g === "line" ? "Lines" : "Words"}
              </button>
            ))}
          </div>
        </div>
        <PayloadDiff row={row} field={field} granularity={granularity} />
      </div>
    </section>
  );
}

function PayloadDiff({ row, field, granularity }: { row: DiffRow; field: PayloadField; granularity: TextGranularity }) {
  const diff = useMemo(() => diffPayload(row, field, { granularity, context: 3 }), [row, field, granularity]);
  if (diff.identical) {
    return <p className="text-[13px] text-fg-muted">The {field} is identical in both runs.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="tabular text-[12px] text-fg-subtle">
        <span className="text-ok">+{diff.insertions}</span> <span className="text-err">{"−"}{diff.deletions}</span>{" "}
        {granularity === "line" ? "lines" : "words"}
        {!diff.exact && ", too different to align, shown as a replacement"}
      </p>
      {granularity === "line" ? <HunkView diff={diff} /> : <InlineDiffView diff={diff} />}
    </div>
  );
}

function SideFacts({ label, span, row, border }: { label: string; span: SpanRef | undefined; row: DiffRow; border?: boolean }) {
  const changed = new Set(row.changes.filter((c) => c.significant).map((c) => c.field));
  const facts: { field: FieldChange["field"]; label: string; value: string }[] = span
    ? [
        { field: "status", label: "Status", value: span.status === "error" ? `Error: ${span.error?.type ?? "unknown"}` : "OK" },
        { field: "model", label: "Model", value: span.model ?? "–" },
        { field: "latency", label: "Duration", value: formatDuration(span.durationMs) },
        { field: "tokens", label: "Tokens", value: formatTokens(span.tokens.total) },
        { field: "cost", label: "Cost", value: formatCost(span.costUsd) },
      ]
    : [];
  return (
    <div className={`min-w-0 px-4 py-3 ${border ? "border-l border-border" : ""}`}>
      <div className="mb-1.5 text-[11.5px] font-semibold text-fg-subtle">Run {label}</div>
      {span ? (
        <dl className="flex flex-col gap-1 text-[12.5px]">
          {facts.map((f) => (
            <div key={f.label} className="flex min-w-0 justify-between gap-2">
              <dt className="text-fg-subtle">{f.label}</dt>
              <dd className={`tabular truncate ${changed.has(f.field) ? "font-medium text-fg" : "text-fg-muted"}`} title={f.value}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[12.5px] text-fg-subtle">Not in this run.</p>
      )}
    </div>
  );
}

function ChangeValue({ change }: { change: FieldChange }) {
  switch (change.field) {
    case "tokens":
    case "cost":
    case "latency": {
      const fmt = change.field === "tokens" ? formatTokens : change.field === "cost" ? formatCost : formatDuration;
      const left = metricValue(change.left);
      const right = metricValue(change.right);
      const ratio = change.delta !== undefined ? formatRatio(change.delta, left) : null;
      return (
        <span className="tabular">
          {fmt(left)} {"→"} {fmt(right)}
          {change.delta !== undefined && (
            <span className="text-fg-muted">
              {" "}
              ({formatSigned(change.delta, (v) => fmt(v))}
              {ratio && `, ${ratio}`})
            </span>
          )}
        </span>
      );
    }
    case "input":
    case "output":
      return <span className="text-fg-muted">Changed, see the {change.field} diff below</span>;
    default:
      return (
        <span className="break-words">
          {describe(change.left)} {"→"} {describe(change.right)}
        </span>
      );
  }
}

/** Metric sides are numbers, except tokens, which carry a { input, output, total } breakdown. */
function metricValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "total" in value) {
    const total = (value as { total: unknown }).total;
    return typeof total === "number" ? total : null;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "type" in value && "message" in value) {
    const e = value as { type: unknown; message: unknown };
    return `${String(e.type)}: ${String(e.message)}`;
  }
  return JSON.stringify(value);
}
