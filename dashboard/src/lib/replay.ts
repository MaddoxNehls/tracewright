/**
 * Replay metadata, as the SDK's replay() records it: the replay's root span
 * carries `tracewright.replay_of` and `tracewright.replay_from_step`, and every
 * call served from the recording carries `tracewright.replayed = true`.
 */
import type { Span } from "./types";

export interface ReplayInfo {
  /** Trace id of the run this one replays. */
  of: string;
  /** Steps before this one were served from the recording. */
  fromStep: number | null;
}

/** Replay metadata from the root span (`tracewright.replay_of`, `tracewright.replay_from_step`). */
export function replayInfo(spans: readonly Pick<Span, "parentSpanId" | "attributes">[]): ReplayInfo | null {
  const root = spans.find((s) => s.parentSpanId === null);
  const of = root?.attributes["tracewright.replay_of"];
  if (typeof of !== "string" || !of) return null;
  const step = root?.attributes["tracewright.replay_from_step"];
  return { of, fromStep: typeof step === "number" ? step : null };
}

/** The span was served from a recording during a replay rather than executed. */
export function isReplayed(attributes: Record<string, unknown> | null | undefined): boolean {
  return attributes?.["tracewright.replayed"] === true;
}
