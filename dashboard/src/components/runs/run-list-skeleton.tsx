export function RunListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading runs">
      <div className="flex gap-2">
        <span className="skeleton h-8 w-64" />
        <span className="skeleton h-8 w-36" />
        <span className="skeleton h-8 w-32" />
        <span className="skeleton h-8 w-28" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="h-9 border-b border-border" />
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 border-b border-border px-4 py-3.5 last:border-b-0">
            <span className="skeleton h-3.5 w-12" />
            <span className="skeleton h-3.5 w-72" />
            <span className="skeleton h-3.5 w-28" />
            <span className="skeleton h-3.5 w-20" />
            <span className="skeleton ml-auto h-3.5 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
