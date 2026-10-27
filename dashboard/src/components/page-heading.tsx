import type { ReactNode } from "react";

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-[70ch] text-[13px] text-fg-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
