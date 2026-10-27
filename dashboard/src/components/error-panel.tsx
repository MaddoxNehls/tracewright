"use client";

import { useEffect } from "react";

/** Shared body for route error boundaries. Names what failed and offers the one useful action. */
export function ErrorPanel({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start gap-3 px-2 py-16">
      <h1 className="text-xl font-semibold tracking-tight text-fg">This page couldn&apos;t load its data</h1>
      <p className="text-[14px] text-fg-muted">
        The dashboard couldn&apos;t read from the database. If you&apos;re running locally, check that Postgres is up and DATABASE_URL points at
        it, then try again.
      </p>
      {error.digest && <p className="font-mono text-[12px] text-fg-subtle">Error reference: {error.digest}</p>}
      <button
        type="button"
        onClick={reset}
        className="mt-1 inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-[13px] font-medium text-fg hover:bg-surface-2"
      >
        Try again
      </button>
    </div>
  );
}
