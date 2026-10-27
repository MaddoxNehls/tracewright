/**
 * Deterministic generator for realistic research-agent traces, shaped exactly
 * like what the Python SDK emits (OpenTelemetry GenAI attribute names,
 * Anthropic-style message payloads). Used by `pnpm seed` and by the landing
 * page hero, which renders a generated run without touching the database.
 */
import type { JsonValue, RunStatus, Span, SpanError, SpanKind } from "@/lib/types";
import { TOPICS, type Topic } from "./topics";

// ---------------------------------------------------------------- randomness

/** mulberry32: tiny, fast, seedable PRNG. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    hex: (length: number) => Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join(""),
  };
}
type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------- models

interface ModelSpec {
  id: string;
  responseModel: string;
  provider: "anthropic" | "openrouter";
  inputPerMtok: number;
  outputPerMtok: number;
  msPerOutputToken: number;
}

const MODELS = {
  sonnet: { id: "claude-sonnet-4-5", responseModel: "claude-sonnet-4-5-20250929", provider: "anthropic", inputPerMtok: 3, outputPerMtok: 15, msPerOutputToken: 13 },
  haiku: { id: "claude-haiku-4-5", responseModel: "claude-haiku-4-5-20251001", provider: "anthropic", inputPerMtok: 1, outputPerMtok: 5, msPerOutputToken: 6 },
  opus: { id: "claude-opus-4-1", responseModel: "claude-opus-4-1-20250805", provider: "anthropic", inputPerMtok: 15, outputPerMtok: 75, msPerOutputToken: 26 },
  gptMini: { id: "openai/gpt-4.1-mini", responseModel: "openai/gpt-4.1-mini-2025-04-14", provider: "openrouter", inputPerMtok: 0.4, outputPerMtok: 1.6, msPerOutputToken: 9 },
} as const satisfies Record<string, ModelSpec>;

interface AgentConfig {
  planner: ModelSpec;
  summarizer: ModelSpec;
  synthesizer: ModelSpec;
}

const CONFIGS: AgentConfig[] = [
  { planner: MODELS.sonnet, summarizer: MODELS.haiku, synthesizer: MODELS.sonnet },
  { planner: MODELS.sonnet, summarizer: MODELS.haiku, synthesizer: MODELS.opus },
  { planner: MODELS.gptMini, summarizer: MODELS.gptMini, synthesizer: MODELS.gptMini },
  { planner: MODELS.haiku, summarizer: MODELS.haiku, synthesizer: MODELS.sonnet },
];

const cost = (m: ModelSpec, input: number, output: number) =>
  Math.round(((input * m.inputPerMtok + output * m.outputPerMtok) / 1_000_000) * 1e6) / 1e6;

// ---------------------------------------------------------------- failure plan

export type Incident =
  | "none"
  | "search_timeout_recovered"
  | "rate_limit_recovered"
  | "synth_overloaded_fatal"
  | "calculator_fatal"
  | "context_overflow_fatal"
  | "search_exhausted_fatal";

// ---------------------------------------------------------------- builder

export interface GeneratedSpan extends Span {
  traceId: string;
}

export interface GeneratedRun {
  traceId: string;
  status: RunStatus;
  spans: GeneratedSpan[];
}

class TraceBuilder {
  readonly spans: GeneratedSpan[] = [];
  constructor(
    readonly rng: Rng,
    readonly traceId: string,
  ) {}

  add(s: {
    parent: string | null;
    name: string;
    kind: SpanKind;
    start: number;
    end: number;
    status?: RunStatus;
    error?: SpanError | null;
    attributes?: Record<string, JsonValue>;
    input?: JsonValue;
    output?: JsonValue;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
  }): string {
    const spanId = this.rng.hex(16);
    this.spans.push({
      traceId: this.traceId,
      spanId,
      parentSpanId: s.parent,
      name: s.name,
      kind: s.kind,
      startTime: new Date(s.start).toISOString(),
      endTime: new Date(s.end).toISOString(),
      durationMs: s.end - s.start,
      status: s.status ?? "ok",
      error: s.error ?? null,
      attributes: s.attributes ?? {},
      input: s.input ?? null,
      output: s.output ?? null,
      model: s.model ?? null,
      inputTokens: s.inputTokens ?? null,
      outputTokens: s.outputTokens ?? null,
      costUsd: s.costUsd ?? null,
    });
    return spanId;
  }

  /** Patches a span after its children are known (end time, status, output). */
  patch(spanId: string, patch: Partial<Pick<Span, "endTime" | "status" | "error" | "output">> & { end?: number }) {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    if (patch.end !== undefined) {
      span.endTime = new Date(patch.end).toISOString();
      span.durationMs = patch.end - new Date(span.startTime).getTime();
    }
    if (patch.status) span.status = patch.status;
    if (patch.error !== undefined) span.error = patch.error;
    if (patch.output !== undefined) span.output = patch.output;
  }
}

type Message = { role: "user" | "assistant"; content: string | JsonValue[] };

interface LlmCall {
  parent: string;
  start: number;
  model: ModelSpec;
  system: string;
  messages: Message[];
  inputTokens: number;
  outputTokens: number;
  responseContent: JsonValue[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  tools?: string[];
  error?: SpanError;
}

function llmSpan(b: TraceBuilder, call: LlmCall): number {
  const rng = b.rng;
  const ttft = rng.int(280, 900);
  const failed = Boolean(call.error);
  const outputTokens = failed ? 0 : call.outputTokens;
  const latency = failed ? rng.int(120, 900) : ttft + outputTokens * call.model.msPerOutputToken + rng.int(0, 400);
  const end = call.start + latency;
  const usd = failed ? 0 : cost(call.model, call.inputTokens, outputTokens);

  const attributes: Record<string, JsonValue> = {
    "gen_ai.provider.name": call.model.provider,
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": call.model.id,
    "gen_ai.request.max_tokens": 4096,
    "gen_ai.request.temperature": 0.2,
    "gen_ai.usage.input_tokens": failed ? 0 : call.inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
    "tracewright.cost_usd": usd,
  };
  if (!failed) {
    attributes["gen_ai.response.model"] = call.model.responseModel;
    attributes["gen_ai.response.finish_reasons"] = [call.stopReason];
    attributes["gen_ai.response.id"] = `msg_${rng.hex(24)}`;
  }

  b.add({
    parent: call.parent,
    name: `chat ${call.model.id}`,
    kind: "llm",
    start: call.start,
    end,
    status: failed ? "error" : "ok",
    error: call.error ?? null,
    attributes,
    input: {
      model: call.model.id,
      max_tokens: 4096,
      system: call.system,
      messages: call.messages as JsonValue,
      ...(call.tools ? { tools: call.tools.map((name) => ({ name })) } : {}),
    },
    output: failed
      ? null
      : {
          role: "assistant",
          content: call.responseContent,
          stop_reason: call.stopReason,
          usage: { input_tokens: call.inputTokens, output_tokens: outputTokens },
        },
    model: call.model.id,
    inputTokens: failed ? 0 : call.inputTokens,
    outputTokens,
    costUsd: usd,
  });
  return end;
}

function toolSpan(
  b: TraceBuilder,
  t: { parent: string; start: number; name: string; latency: number; input: JsonValue; output: JsonValue; error?: SpanError },
): number {
  const end = t.start + t.latency;
  b.add({
    parent: t.parent,
    name: t.name,
    kind: "tool",
    start: t.start,
    end,
    status: t.error ? "error" : "ok",
    error: t.error ?? null,
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": t.name },
    input: t.input,
    output: t.error ? null : t.output,
  });
  return end;
}

const SYSTEM_PROMPTS = {
  v1: "You are a research assistant. Search the web, read sources, and answer the user's question.",
  v2: "You are a careful research assistant. Plan 2-3 targeted searches, read the most authoritative sources, compute any numbers explicitly with the calculator tool, and answer in under 120 words with citations. If evidence is mixed, say so.",
};

export interface RunOptions {
  index: number;
  topic: Topic;
  promptVersion: "v1" | "v2";
  config: AgentConfig;
  startMs: number;
  incident: Incident;
  tags: string[];
  seed: number;
}

export function generateRun(opts: RunOptions): GeneratedRun {
  const rng = createRng(opts.seed);
  const b = new TraceBuilder(rng, rng.hex(32));
  const { topic, config } = opts;
  const system = SYSTEM_PROMPTS[opts.promptVersion];
  const t0 = opts.startMs;

  const root = b.add({
    parent: null,
    name: `research: ${topic.title}`,
    kind: "agent",
    start: t0,
    end: t0,
    attributes: {
      "tracewright.tags": opts.tags,
      "agent.name": "research-agent",
      "agent.version": "0.4.2",
      "prompt.version": opts.promptVersion,
    },
    input: { question: topic.question },
  });

  let t = t0 + rng.int(4, 30);
  let fatal: SpanError | null = null;

  // 1. plan
  const plan = b.add({ parent: root, name: "plan", kind: "custom", start: t, end: t });
  const planToolUses: JsonValue[] = topic.queries.map((q) => ({ type: "tool_use", id: `toolu_${rng.hex(20)}`, name: "web_search", input: { query: q } }));
  const userMsg: Message = { role: "user", content: topic.question };

  if (opts.incident === "rate_limit_recovered") {
    t = llmSpan(b, {
      parent: plan, start: t, model: config.planner, system, messages: [userMsg], inputTokens: 0, outputTokens: 0,
      responseContent: [], stopReason: "end_turn", tools: ["web_search", "fetch_page", "calculator", "save_note"],
      error: { type: "rate_limit_error", message: "429: Number of request tokens has exceeded your per-minute rate limit. Retry after 2s." },
    });
    t += 2000 + rng.int(0, 300); // SDK backoff
  }
  t = llmSpan(b, {
    parent: plan, start: t, model: config.planner, system, messages: [userMsg],
    inputTokens: rng.int(620, 980), outputTokens: rng.int(140, 320),
    responseContent: [{ type: "text", text: `I'll search for ${topic.queries.length} angles on this, then read the strongest sources.` }, ...planToolUses],
    stopReason: "tool_use", tools: ["web_search", "fetch_page", "calculator", "save_note"],
  });
  b.patch(plan, { end: t + rng.int(1, 6), output: { queries: topic.queries } });
  t += rng.int(5, 25);

  // 2. one search step per query
  const summaries: string[] = [];
  for (const [qi, q] of topic.queries.entries()) {
    const step = b.add({ parent: root, name: `search: ${q}`, kind: "custom", start: t, end: t, input: { query: q } });
    t += rng.int(2, 10);

    const exhausted = opts.incident === "search_exhausted_fatal" && qi === 0;
    const attempts = exhausted ? 3 : opts.incident === "search_timeout_recovered" && qi === 0 ? 2 : 1;
    let searchOk = false;
    for (let a = 1; a <= attempts; a++) {
      const fails = a < attempts || exhausted;
      t = toolSpan(b, {
        parent: step, start: t, name: "web_search",
        latency: fails ? 10_000 : rng.int(380, 1600),
        input: { query: q, max_results: 5, attempt: a },
        output: { results: topic.sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet })) },
        error: fails ? { type: "TimeoutError", message: "web_search timed out after 10.0s (search provider did not respond)" } : undefined,
      });
      t += fails ? 500 * a : rng.int(2, 12);
      if (!fails) searchOk = true;
    }
    if (!searchOk) {
      fatal = { type: "ToolError", message: `web_search failed 3 times for "${q}"; no sources to ground an answer` };
      b.patch(step, { end: t, status: "error", error: fatal });
      break;
    }

    // Parallel page fetches overlap in time, which the waterfall should show.
    const pages = topic.sources.slice(0, rng.int(1, Math.min(2, topic.sources.length)));
    const fetchStart = t;
    let fetchEnd = t;
    for (const [pi, src] of pages.entries()) {
      const end = toolSpan(b, {
        parent: step, start: fetchStart + pi * rng.int(3, 15), name: "fetch_page", latency: rng.int(260, 2300),
        input: { url: src.url },
        output: { url: src.url, status: 200, content_type: "text/html", chars: rng.int(8_000, 60_000), excerpt: src.snippet },
      });
      fetchEnd = Math.max(fetchEnd, end);
    }
    t = fetchEnd + rng.int(3, 15);

    const summary = `${pages.map((p) => p.title).join("; ")}: ${pages.map((p) => p.snippet).join(" ")}`;
    summaries.push(summary);
    t = llmSpan(b, {
      parent: step, start: t, model: config.summarizer,
      system: "Summarize the fetched pages into the facts relevant to the question. Keep numbers and units exact.",
      messages: [
        { role: "user", content: `Question: ${topic.question}` },
        {
          role: "user",
          content: pages.map((p) => ({ type: "tool_result", tool_use_id: `toolu_${rng.hex(20)}`, content: `${p.title}\n${p.url}\n\n${p.snippet}` })),
        },
      ],
      inputTokens: rng.int(2400, 6800), outputTokens: rng.int(160, 420),
      responseContent: [{ type: "text", text: summary }],
      stopReason: "end_turn",
    });
    t += rng.int(2, 10);
    b.patch(step, { end: t, output: { sources: pages.length, summary_chars: summary.length } });
    t += rng.int(5, 40);
  }

  // 3. compute
  if (!fatal && topic.calc) {
    const step = b.add({ parent: root, name: "compute", kind: "custom", start: t, end: t });
    t += rng.int(1, 5);
    const calcFails = opts.incident === "calculator_fatal";
    const expression = calcFails ? topic.calc.expression.replace(/\d+(\.\d+)?\s*\)?$/, "0)") : topic.calc.expression;
    t = toolSpan(b, {
      parent: step, start: t, name: "calculator", latency: rng.int(2, 18),
      input: { expression, purpose: topic.calc.purpose },
      output: { result: topic.calc.result },
      error: calcFails ? { type: "ZeroDivisionError", message: `division by zero while evaluating "${expression}"` } : undefined,
    });
    t += rng.int(1, 4);
    if (calcFails) {
      fatal = { type: "ZeroDivisionError", message: "calculator raised ZeroDivisionError; agent has no fallback for failed computations" };
      b.patch(step, { end: t, status: "error", error: fatal });
    } else {
      b.patch(step, { end: t, output: { result: topic.calc.result } });
    }
    t += rng.int(5, 30);
  }

  // 4. synthesize
  let answer: string | null = null;
  if (!fatal) {
    const step = b.add({ parent: root, name: "synthesize", kind: "custom", start: t, end: t });
    t += rng.int(2, 8);
    const messages: Message[] = [
      userMsg,
      { role: "assistant", content: planToolUses },
      { role: "user", content: summaries.map((s, i) => ({ type: "tool_result", tool_use_id: `toolu_${rng.hex(20)}`, content: `[${i + 1}] ${s}` })) },
    ];
    const sources = topic.sources.map((s, i) => `[${i + 1}] ${s.url}`).join("\n");
    const finalText = `${topic.answer}\n\nSources:\n${sources}`;

    if (opts.incident === "context_overflow_fatal") {
      fatal = { type: "invalid_request_error", message: "prompt is too long: 212417 tokens > 200000 maximum" };
      t = llmSpan(b, { parent: step, start: t, model: config.synthesizer, system, messages, inputTokens: 0, outputTokens: 0, responseContent: [], stopReason: "end_turn", error: fatal });
    } else {
      const overloadAttempts = opts.incident === "synth_overloaded_fatal" ? 2 : 0;
      for (let a = 0; a < overloadAttempts; a++) {
        t = llmSpan(b, {
          parent: step, start: t, model: config.synthesizer, system, messages, inputTokens: 0, outputTokens: 0, responseContent: [], stopReason: "end_turn",
          error: { type: "overloaded_error", message: "529: Overloaded" },
        });
        t += 1000 * 2 ** a + rng.int(0, 250);
      }
      if (overloadAttempts > 0) {
        fatal = { type: "overloaded_error", message: `synthesize failed after ${overloadAttempts} attempts: 529 Overloaded` };
      } else {
        t = llmSpan(b, {
          parent: step, start: t, model: config.synthesizer, system, messages,
          inputTokens: rng.int(3200, 7600), outputTokens: rng.int(380, 900),
          responseContent: [{ type: "text", text: finalText }], stopReason: "end_turn",
        });
        answer = topic.answer;
      }
    }
    t += rng.int(2, 8);
    b.patch(step, fatal ? { end: t, status: "error", error: fatal } : { end: t, output: { answer_chars: finalText.length } });
    t += rng.int(3, 12);
  }

  // 5. save notes (only on success)
  if (answer) {
    t = toolSpan(b, {
      parent: root, start: t, name: "save_note", latency: rng.int(8, 45),
      input: { key: topic.title.replace(/\s+/g, "-"), text: answer },
      output: { ok: true, id: `note_${rng.hex(10)}` },
    });
    t += rng.int(1, 6);
  }

  b.patch(root, {
    end: t,
    status: fatal ? "error" : "ok",
    error: fatal,
    output: answer ? { answer, sources: topic.sources.map((s) => s.url) } : null,
  });

  return { traceId: b.traceId, status: fatal ? "error" : "ok", spans: b.spans };
}

// ---------------------------------------------------------------- demo dataset

const INCIDENTS: Partial<Record<number, Incident>> = {
  3: "search_timeout_recovered",
  6: "rate_limit_recovered",
  8: "synth_overloaded_fatal",
  11: "search_timeout_recovered",
  15: "calculator_fatal",
  20: "search_timeout_recovered",
  22: "context_overflow_fatal",
  23: "rate_limit_recovered",
  27: "search_timeout_recovered",
  30: "search_exhausted_fatal",
};

/**
 * The demo project's 32 runs: every topic under prompt v1 and v2, spread over
 * the 14 days before `anchorMs`, newest last.
 */
export function generateDemoRuns(anchorMs: number, seed = 20261027): GeneratedRun[] {
  const rng = createRng(seed);
  const runs: GeneratedRun[] = [];
  const total = TOPICS.length * 2;
  const spanMs = 14 * 24 * 3600_000;

  for (let index = 0; index < total; index++) {
    const topic = TOPICS[index % TOPICS.length]!;
    const promptVersion = index < TOPICS.length ? "v1" : "v2";
    const config = CONFIGS[(index + (promptVersion === "v2" ? 1 : 0)) % CONFIGS.length]!;
    const env = index % 5 === 0 ? "prod" : "eval";
    const tags = [env, `prompt-${promptVersion}`, ...(index % 3 === 0 ? ["nightly"] : [])];
    const offset = spanMs * (1 - (index + rng.next() * 0.8) / total);
    const startMs = Math.round(anchorMs - offset);
    runs.push(
      generateRun({ index, topic, promptVersion, config, startMs, incident: INCIDENTS[index] ?? "none", tags, seed: seed + index * 7919 }),
    );
  }
  return runs;
}

/** A single representative run (with a recovered tool timeout) for the landing page hero. */
export function generateHeroRun(): GeneratedRun {
  return generateRun({
    index: 0,
    topic: TOPICS[7]!,
    promptVersion: "v2",
    config: CONFIGS[1]!,
    startMs: Date.UTC(2026, 9, 20, 14, 2, 11),
    incident: "search_timeout_recovered",
    tags: ["eval", "prompt-v2"],
    seed: 4242,
  });
}
