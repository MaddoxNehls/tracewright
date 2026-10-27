import type { SpanKind } from "./types";

export const KIND_LABEL: Record<SpanKind, string> = {
  agent: "Agent",
  llm: "LLM call",
  tool: "Tool call",
  custom: "Step",
};

/** Literal class names so Tailwind can see them. */
export const KIND_BG: Record<SpanKind, string> = {
  agent: "bg-kind-agent",
  llm: "bg-kind-llm",
  tool: "bg-kind-tool",
  custom: "bg-kind-custom",
};

export const KIND_TEXT: Record<SpanKind, string> = {
  agent: "text-kind-agent",
  llm: "text-kind-llm",
  tool: "text-kind-tool",
  custom: "text-fg-muted",
};
