"use client";

import { CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { KIND_BG, KIND_LABEL } from "@/lib/kinds";
import { toTranscript } from "@/lib/llm-messages";
import type { JsonValue, Span } from "@/lib/types";
import { CopyButton } from "../copy-button";
import { JsonView } from "../json-view";
import { StatusBadge } from "../status";
import { Conversation } from "./conversation";

type Tab = "conversation" | "input" | "output" | "attributes";

const TAB_LABEL: Record<Tab, string> = {
  conversation: "Conversation",
  input: "Input",
  output: "Output",
  attributes: "Attributes",
};

interface Props {
  span: Span;
  /** Milliseconds from the start of the run to the start of this span. */
  offsetMs: number;
}

export function SpanInspector({ span, offsetMs }: Props) {
  const isLlm = span.kind === "llm";
  const tabs: Tab[] = isLlm ? ["conversation", "input", "output", "attributes"] : ["input", "output", "attributes"];
  const [requested, setTab] = useState<Tab>(tabs[0]!);
  // Moving from an LLM span to a tool span drops the conversation tab; fall back to the first tab.
  const tab = tabs.includes(requested) ? requested : tabs[0]!;

  const finishReasons = span.attributes["gen_ai.response.finish_reasons"];
  const provider = span.attributes["gen_ai.provider.name"];
  const toolName = span.attributes["gen_ai.tool.name"];

  return (
    <section aria-label="Span inspector" className="flex flex-col" data-testid="span-inspector">
      <header className="border-b border-border px-4 pb-4 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
            <span className={`size-2 rounded-[2px] ${KIND_BG[span.kind]}`} aria-hidden />
            {KIND_LABEL[span.kind]}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-fg-subtle">
            {span.spanId}
            <CopyButton value={span.spanId} label="Copy span ID" />
          </span>
        </div>
        <h2 className="mt-1.5 break-words text-[15px] font-semibold leading-snug text-fg">{span.name}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-fg-muted">
          <StatusBadge status={span.status} />
          <span className="tabular">{formatDuration(span.durationMs)}</span>
          <span className="tabular" title="Start, relative to the start of the run">
            starts at +{formatDuration(offsetMs)}
          </span>
        </div>

        {span.error && (
          <div role="alert" className="mt-3 flex gap-2 rounded-md border border-err-border bg-err-soft px-3 py-2.5">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-err" aria-hidden />
            <div className="min-w-0 text-[12.5px]">
              <div className="font-mono font-medium text-err">{span.error.type}</div>
              <div className="mt-0.5 break-words text-fg">{span.error.message}</div>
            </div>
          </div>
        )}

        {isLlm && (
          <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3">
            <Metric label="Model" value={span.model ?? "unknown"} wide />
            <Metric label="Provider" value={typeof provider === "string" ? provider : "–"} />
            <Metric label="Input tokens" value={formatTokens(span.inputTokens)} />
            <Metric label="Output tokens" value={formatTokens(span.outputTokens)} />
            <Metric label="Cost" value={formatCost(span.costUsd)} />
            <Metric label="Latency" value={formatDuration(span.durationMs)} />
            <Metric
              label="Throughput"
              value={span.outputTokens && span.durationMs > 0 ? `${Math.round((span.outputTokens / span.durationMs) * 1000)} tok/s` : "–"}
            />
            <Metric label="Finish reason" value={Array.isArray(finishReasons) ? finishReasons.join(", ") : "–"} />
          </dl>
        )}
        {span.kind === "tool" && typeof toolName === "string" && (
          <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3">
            <Metric label="Tool" value={toolName} />
            <Metric label="Latency" value={formatDuration(span.durationMs)} />
          </dl>
        )}
      </header>

      <div role="tablist" aria-label="Span details" className="flex gap-1 border-b border-border px-3">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-selected={t === tab}
            aria-controls={`panel-${t}`}
            onClick={() => setTab(t)}
            className={`relative h-9 px-2 text-[12.5px] font-medium transition-colors ${
              t === tab ? "text-fg after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-muted hover:text-fg"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="px-4 py-4">
        <TabBody span={span} tab={tab} />
      </div>
    </section>
  );
}

function TabBody({ span, tab }: { span: Span; tab: Tab }) {
  const transcript = useMemo(() => toTranscript(span.input, span.output), [span.input, span.output]);
  switch (tab) {
    case "conversation":
      return <Conversation transcript={transcript} />;
    case "input":
      return <Payload value={span.input} empty="No input was recorded for this span." />;
    case "output":
      return <Payload value={span.output} empty={span.status === "error" ? "No output: this span failed." : "No output was recorded for this span."} />;
    case "attributes":
      return <Payload value={span.attributes as JsonValue} empty="No attributes." />;
  }
}

function Payload({ value, empty }: { value: JsonValue; empty: string }) {
  const isEmpty = value === null || (typeof value === "object" && Object.keys(value).length === 0);
  if (isEmpty) return <p className="text-[13px] text-fg-muted">{empty}</p>;
  return <JsonView value={value} />;
}

function Metric({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <dt className="text-[11.5px] text-fg-subtle">{label}</dt>
      <dd className="tabular mt-0.5 truncate text-[13px] text-fg" title={value}>
        {value}
      </dd>
    </div>
  );
}
