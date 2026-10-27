"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { JsonValue } from "@/lib/types";

/** Syntax-colored, collapsible JSON. Nodes deeper than `openDepth` start collapsed. */
export function JsonView({ value, openDepth = 3 }: { value: JsonValue; openDepth?: number }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface-2/60 px-3 py-2.5 font-mono text-[12px] leading-[1.6]">
      <Node value={value} depth={0} openDepth={openDepth} />
    </div>
  );
}

function Node({ value, depth, openDepth, name, trailingComma }: { value: JsonValue; depth: number; openDepth: number; name?: string; trailingComma?: boolean }) {
  const [open, setOpen] = useState(depth < openDepth);
  const comma = trailingComma ? <span className="text-fg-subtle">,</span> : null;
  const key = name !== undefined ? (
    <>
      <span className="text-[var(--json-key)]">&quot;{name}&quot;</span>
      <span className="text-fg-subtle">: </span>
    </>
  ) : null;

  if (value === null || typeof value !== "object") {
    return (
      <div className="whitespace-pre-wrap break-words pl-4">
        {key}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string | undefined, JsonValue][] = isArray
    ? value.map((v) => [undefined, v])
    : Object.entries(value);
  const [openBrace, closeBrace] = isArray ? ["[", "]"] : ["{", "}"];

  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {key}
        <span className="text-fg-subtle">{openBrace + closeBrace}</span>
        {comma}
      </div>
    );
  }

  return (
    <div className="relative pl-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Collapse" : "Expand"}
        className="absolute left-0 top-[3px] flex size-3.5 items-center justify-center rounded text-fg-subtle hover:text-fg"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {key}
      <span className="text-fg-subtle">{openBrace}</span>
      {open ? (
        <>
          {entries.map(([k, v], i) => (
            <Node key={k ?? i} name={k} value={v} depth={depth + 1} openDepth={openDepth} trailingComma={i < entries.length - 1} />
          ))}
          <span className="text-fg-subtle">{closeBrace}</span>
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="text-fg-subtle hover:text-fg">
          {` … ${entries.length} ${isArray ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"} `}
          {closeBrace}
        </button>
      )}
      {comma}
    </div>
  );
}

function Primitive({ value }: { value: string | number | boolean | null }) {
  if (typeof value === "string") return <span className="text-[var(--json-string)]">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="text-[var(--json-number)]">{value}</span>;
  return <span className="text-[var(--json-literal)]">{String(value)}</span>;
}
