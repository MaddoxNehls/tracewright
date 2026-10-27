/** Helpers for asserting on recorded spans in tests: `import { InMemoryExporter } from "tracewright/testing"`. */

import type { Exporter, ExporterStats } from "./exporter.ts";
import type { Span, SpanRecord } from "./span.ts";

/** Collects finished spans in wire format instead of sending them. */
export class InMemoryExporter implements Exporter {
  #spans: SpanRecord[] = [];

  export(span: Span): void {
    this.#spans.push(span.toJSON());
  }

  flush(): Promise<boolean> {
    return Promise.resolve(true);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  get stats(): ExporterStats {
    return { exported: this.#spans.length, droppedQueueFull: 0, failed: 0 };
  }

  /** Finished spans in the order they ended (children before parents). */
  get spans(): readonly SpanRecord[] {
    return [...this.#spans];
  }

  clear(): void {
    this.#spans = [];
  }

  byName(name: string): SpanRecord[] {
    return this.#spans.filter((s) => s.name === name);
  }

  /** Direct children of `spanId`, ordered by start time. */
  childrenOf(spanId: string): SpanRecord[] {
    return this.#spans
      .filter((s) => s.parent_span_id === spanId)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  roots(): SpanRecord[] {
    return this.#spans.filter((s) => s.parent_span_id === null);
  }
}
