"use client";

import type { TextDiff } from "@tracewright/run-diff";

/** Unified, line-numbered rendering of a line-granularity diff's hunks. */
export function HunkView({ diff }: { diff: TextDiff }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border font-mono text-[11.5px] leading-[1.55]" data-testid="text-diff">
      {diff.hunks.map((h, hi) => (
        <div key={hi} className={hi > 0 ? "border-t border-border" : ""}>
          <div className="bg-surface-2 px-3 py-1 text-fg-subtle">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          <table className="w-full border-collapse">
            <tbody>
              {h.lines.map((l, li) => {
                const tone =
                  l.op === "insert" ? "bg-ok/[0.12] text-fg" : l.op === "delete" ? "bg-err/[0.12] text-fg" : "text-fg-muted";
                const sign = l.op === "insert" ? "+" : l.op === "delete" ? "−" : " ";
                return (
                  <tr key={li} className={tone}>
                    <td className="w-9 select-none pr-1 text-right align-top text-fg-subtle/80">{l.oldLine ?? ""}</td>
                    <td className="w-9 select-none pr-2 text-right align-top text-fg-subtle/80">{l.newLine ?? ""}</td>
                    <td
                      className={`w-4 select-none align-top ${l.op === "insert" ? "text-ok" : l.op === "delete" ? "text-err" : ""}`}
                      aria-label={l.op === "equal" ? undefined : l.op}
                    >
                      {sign}
                    </td>
                    <td className="whitespace-pre-wrap break-words pr-3 align-top">{l.text || " "}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Inline rendering of a word- or char-granularity diff: deletions struck through, insertions highlighted. */
export function InlineDiffView({ diff }: { diff: TextDiff }) {
  return (
    <p
      className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2/40 px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-fg-muted"
      data-testid="text-diff"
    >
      {diff.ops.map((op, i) =>
        op.op === "insert" ? (
          <ins key={i} className="rounded-sm bg-ok/20 text-fg no-underline">
            {op.text}
          </ins>
        ) : op.op === "delete" ? (
          <del key={i} className="rounded-sm bg-err/20 text-fg">
            {op.text}
          </del>
        ) : (
          <span key={i}>{op.text}</span>
        ),
      )}
    </p>
  );
}
