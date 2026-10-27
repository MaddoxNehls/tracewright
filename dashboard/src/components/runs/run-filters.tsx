"use client";

import { ChevronDown, LoaderCircle, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { DEFAULT_RUN_LIST_PARAMS, hasActiveFilters, runListQueryString, type RunListParams } from "@/lib/run-list-params";
import type { RunStatus } from "@/lib/types";

interface Props {
  basePath: string;
  params: RunListParams;
  models: string[];
  tags: string[];
}

const SEARCH_DEBOUNCE_MS = 300;

export function RunFilters({ basePath, params, models, tags }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.q ?? "");
  const lastCommitted = useRef(params.q ?? "");

  const navigate = (patch: Partial<RunListParams>) => {
    startTransition(() => {
      router.replace(`${basePath}${runListQueryString(params, patch)}`, { scroll: false });
    });
  };

  // Debounced text search; filters and sort stay as they are.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed === lastCommitted.current) return;
    const id = setTimeout(() => {
      lastCommitted.current = trimmed;
      startTransition(() => {
        router.replace(`${basePath}${runListQueryString(params, { q: trimmed || null })}`, { scroll: false });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q, params, basePath, router]);

  const clear = () => {
    setQ("");
    lastCommitted.current = "";
    navigate({ ...DEFAULT_RUN_LIST_PARAMS, sort: params.sort, dir: params.dir });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter runs">
      <label className="relative flex h-8 min-w-0 flex-1 basis-56 items-center sm:max-w-xs">
        <span className="sr-only">Search run names</span>
        <Search className="pointer-events-none absolute left-2.5 size-3.5 text-fg-subtle" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search run names"
          className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-[13px] text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0"
        />
      </label>

      <StatusSegment value={params.status} onChange={(status) => navigate({ status })} />

      <FilterSelect label="Model" value={params.model} options={models} allLabel="All models" onChange={(model) => navigate({ model })} />
      <FilterSelect label="Tag" value={params.tag} options={tags} allLabel="All tags" onChange={(tag) => navigate({ tag })} />

      {hasActiveFilters(params) && (
        <button
          type="button"
          onClick={clear}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
          Clear filters
        </button>
      )}

      <span className="ml-auto inline-flex h-8 w-5 items-center justify-center" aria-live="polite">
        {pending && <LoaderCircle className="size-4 animate-spin text-fg-subtle" aria-label="Updating results" />}
      </span>
    </div>
  );
}

function StatusSegment({ value, onChange }: { value: RunStatus | null; onChange: (v: RunStatus | null) => void }) {
  const options: { value: RunStatus | null; label: string }[] = [
    { value: null, label: "All" },
    { value: "ok", label: "OK" },
    { value: "error", label: "Error" },
  ];
  return (
    <div role="radiogroup" aria-label="Status" className="inline-flex h-8 items-center rounded-md border border-border bg-surface p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`h-full rounded px-2.5 text-[13px] transition-colors ${
              active ? "bg-surface-3 font-medium text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  allLabel: string;
  onChange: (v: string | null) => void;
}) {
  // Keep a URL-supplied value selectable even if it no longer exists in the data.
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className="relative inline-flex h-8 items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={`h-8 max-w-[14rem] appearance-none truncate rounded-md border bg-surface pl-2.5 pr-7 text-[13px] focus:outline-none ${
          value ? "border-border-strong text-fg" : "border-border text-fg-muted"
        }`}
      >
        <option value="">{allLabel}</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-fg-subtle" aria-hidden />
    </label>
  );
}
