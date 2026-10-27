export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading overview">
      <span className="skeleton h-6 w-40" />
      <span className="skeleton h-[86px] w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[262px] rounded-lg border border-border bg-surface p-4">
            <span className="skeleton block h-4 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
