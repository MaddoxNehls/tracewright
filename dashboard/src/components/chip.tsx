import type { ReactNode } from "react";

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-5 max-w-full items-center truncate rounded border border-border bg-surface-2 px-1.5 text-[11.5px] leading-none text-fg-muted"
    >
      {children}
    </span>
  );
}
