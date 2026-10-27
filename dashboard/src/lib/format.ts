/** Display formatting. Pure and locale-stable (en-US) so server and client render identically. */

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** Compact axis label: 0, 250ms, 1.5s, 2m. */
export function formatTick(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(2)}s`;
  return `${+(ms / 60_000).toFixed(1)}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "–";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const grouped = new Intl.NumberFormat("en-US");

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n < 10_000 ? grouped.format(n) : compact.format(n);
}

export function formatInteger(n: number): string {
  return grouped.format(n);
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "–";
  return `${(ratio * 100).toFixed(ratio < 0.1 && ratio > 0 ? 1 : 0)}%`;
}

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** Absolute timestamps are shown in UTC so server-rendered HTML matches the client. */
export function formatDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}

const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatDay(iso: string): string {
  return shortDay.format(new Date(iso));
}

export function shortId(id: string, length = 8): string {
  return id.slice(0, length);
}

/** Compact model label for dense tables: drops the vendor prefix ("claude-", "openai/"). Full id belongs in a title. */
export function shortModel(model: string): string {
  return model.replace(/^[\w-]+\//, "").replace(/^claude-/, "");
}

/** A signed change, e.g. "+$0.032", "−1.2 s", "+3". Uses a true minus sign. */
export function formatSigned(delta: number, format: (abs: number) => string): string {
  if (delta === 0) return "±0";
  return `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`;
}

/** Relative change, e.g. "+164%", or null when the baseline is zero or unknown. */
export function formatRatio(delta: number, base: number | null | undefined): string | null {
  if (base == null || base === 0 || !Number.isFinite(delta / base)) return null;
  const pct = (delta / Math.abs(base)) * 100;
  const abs = Math.abs(pct);
  return `${pct >= 0 ? "+" : "−"}${abs < 10 ? abs.toFixed(1) : Math.round(abs)}%`;
}
