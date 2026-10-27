/**
 * The run list's URL state: filters, sort, and cursor all live in search params
 * so every view is linkable. Parsing is a whitelist; unknown values fall back to defaults.
 */
import type { RunStatus } from "./types";

export const SORT_KEYS = ["started", "duration", "cost", "tokens"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const SORT_LABELS: Record<SortKey, string> = {
  started: "Start time",
  duration: "Duration",
  cost: "Cost",
  tokens: "Tokens",
};

export interface RunListParams {
  status: RunStatus | null;
  model: string | null;
  tag: string | null;
  q: string | null;
  sort: SortKey;
  dir: SortDir;
  cursor: string | null;
}

export const DEFAULT_RUN_LIST_PARAMS: RunListParams = {
  status: null,
  model: null,
  tag: null,
  q: null,
  sort: "started",
  dir: "desc",
  cursor: null,
};

export type RawSearchParams = Record<string, string | string[] | undefined>;

const MAX_TEXT = 200;

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseRunListParams(raw: RawSearchParams): RunListParams {
  return {
    status: oneOf(first(raw.status), ["ok", "error"] as const),
    model: first(raw.model),
    tag: first(raw.tag),
    q: first(raw.q),
    sort: oneOf(first(raw.sort), SORT_KEYS) ?? DEFAULT_RUN_LIST_PARAMS.sort,
    dir: oneOf(first(raw.dir), ["asc", "desc"] as const) ?? DEFAULT_RUN_LIST_PARAMS.dir,
    cursor: first(raw.cursor),
  };
}

/**
 * Serializes params back to a query string, omitting defaults. Any change other
 * than the cursor itself resets pagination, since a cursor is only valid for
 * the filter and sort it was issued under.
 */
export function runListQueryString(current: RunListParams, patch: Partial<RunListParams> = {}): string {
  const next: RunListParams = { ...current, ...patch };
  if (!("cursor" in patch)) next.cursor = null;

  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.status) sp.set("status", next.status);
  if (next.model) sp.set("model", next.model);
  if (next.tag) sp.set("tag", next.tag);
  if (next.sort !== DEFAULT_RUN_LIST_PARAMS.sort) sp.set("sort", next.sort);
  if (next.dir !== DEFAULT_RUN_LIST_PARAMS.dir) sp.set("dir", next.dir);
  if (next.cursor) sp.set("cursor", next.cursor);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function hasActiveFilters(p: RunListParams): boolean {
  return Boolean(p.status || p.model || p.tag || p.q);
}
