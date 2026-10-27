export function RunDetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading run">
      <span className="skeleton h-4 w-20" />
      <div className="flex flex-wrap justify-between gap-6">
        <div className="flex flex-col gap-2">
          <span className="skeleton h-6 w-80" />
          <span className="skeleton h-4 w-64" />
        </div>
        <span className="skeleton h-10 w-[420px] max-w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="rounded-lg border border-border bg-surface p-3">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="flex h-[30px] items-center gap-4">
              <span className="skeleton h-3 w-56" style={{ marginLeft: (i % 4) * 14 }} />
              <span className="skeleton h-3" style={{ marginLeft: `${(i * 7) % 40}%`, width: `${10 + ((i * 13) % 30)}%` }} />
            </div>
          ))}
        </div>
        <div className="h-96 rounded-lg border border-border bg-surface" />
      </div>
    </div>
  );
}
