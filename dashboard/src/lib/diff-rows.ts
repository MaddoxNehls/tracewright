import type { DiffRow } from "@tracewright/run-diff";

/** Which diff rows to show: all of them, or only changed rows plus the ancestors that lead to them. */
export function visibleRowIndexes(rows: readonly DiffRow[], onlyChanges: boolean): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (!onlyChanges || r.status !== "same" || r.descendantsChanged) out.push(i);
  });
  return out;
}
