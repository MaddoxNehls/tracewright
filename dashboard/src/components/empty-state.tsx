import type { ReactNode } from "react";

export function EmptyState({ title, body, action, code }: { title: string; body: string; action?: ReactNode; code?: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 sm:items-center sm:text-center">
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      <p className="max-w-[52ch] text-[13px] text-fg-muted">{body}</p>
      {code && (
        <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-surface-2 px-4 py-3 text-left font-mono text-xs text-fg-muted">
          {code}
        </pre>
      )}
      {action}
    </div>
  );
}
