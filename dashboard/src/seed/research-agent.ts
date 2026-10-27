/**
 * Deterministic generator for realistic research-agent traces, shaped exactly
 * like what the Python SDK emits (OpenTelemetry GenAI attribute names,
 * Anthropic-style message payloads, replay attributes). Used by `pnpm seed`
 * and by the landing page, which renders generated runs without a database.
 */
import { priceCall, type PriceTable } from "@/lib/pricing";
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
    hex: (length: number) => Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join(""),
  };
}
type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------- models

interface ModelSpec {
  id: string;
  responseModel: string;
  provider: "anthropic" | "openrouter";
  msPerOutputToken: number;
}

export const MODELS = {
  sonnet: { id: "claude-sonnet-5-5", responseModel: "claude-sonnet-5-5", provider: "anthropic", msPerOutputToken: 11 },
  haiku: { id: "claude-haiku-5-5", responseModel: "claude-haiku-5-5", provider: "anthropic", msPerOutputToken: 5 },
  opus: { id: "claude-opus-5-5", responseModel: "claude-opus-5-5", provider: "anthropic", msPerOutputToken: 19 },
  // Not in ingest's price table, so its cost is unknown (null), exactly as ingest would store it.
  gptMini: { id: "openai/gpt-5-mini", responseModel: "openai/gpt-5-mini-2026-08-07", provider: "openrouter", msPerOutputToken: 8 },
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
    readonly prices: PriceTable,
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
  patch(spanId: string, patch: Partial<Pick<Span, "status" | "error" | "output">> & { end?: number }) {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    if (patch.end !== undefined) {
      span.endTime = new Date(patch.end).toISOString();
      span.durationMs = patch.end - Date.parse(span.startTime);
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
  const inputTokens = failed ? 0 : call.inputTokens;
  const outputTokens = failed ? 0 : call.outputTokens;
  const latency = failed ? rng.int(120, 900) : ttft + outputTokens * call.model.msPerOutputToken + rng.int(0, 400);
  const end = call.start + latency;
  const usd = priceCall(b.prices, call.model.id, inputTokens, outputTokens);

  const attributes: Record<string, JsonValue> = {
    "gen_ai.provider.name": call.model.provider,
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": call.model.id,
    "gen_ai.request.max_tokens": 4096,
    "gen_ai.request.temperature": 0.2,
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
  };
  if (usd !== null) attributes["tracewright.cost_usd"] = usd;
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
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        },
    model: call.model.id,
    inputTokens,
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
  v3: "You are a thorough research assistant. Never answer from a single source: after each search, look for a primary source that confirms it, and keep searching until every claim has two independent citations.",
};
export type PromptVersion = keyof typeof SYSTEM_PROMPTS;

export interface RunOptions {
  topic: Topic;
  promptVersion: PromptVersion;
  config: AgentConfig;
  startMs: number;
  incident: Incident;
  tags: string[];
  seed: number;
  prices: PriceTable;
  /** Follow-up queries the agent runs after its planned ones (an agent that keeps looping). */
  followUpQueries?: string[];
  /** Input tokens of the final synthesis call; defaults to a few thousand. */
  synthInputTokens?: number;
  /** Attempts the agent makes before giving up on an overloaded synthesis call. Default 2. */
  synthAttempts?: number;
}

export function generateRun(opts: RunOptions): GeneratedRun {
  const rng = createRng(opts.seed);
  const b = new TraceBuilder(rng, rng.hex(32), opts.prices);
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
  const tools = ["web_search", "fetch_page", "calculator", "save_note"];

  if (opts.incident === "rate_limit_recovered") {
    t = llmSpan(b, {
      parent: plan, start: t, model: config.planner, system, messages: [userMsg], inputTokens: 0, outputTokens: 0,
      responseContent: [], stopReason: "end_turn", tools,
      error: { type: "rate_limit_error", message: "429: Number of request tokens has exceeded your per-minute rate limit. Retry after 2s." },
    });
    t += 2000 + rng.int(0, 300); // SDK backoff
  }
  t = llmSpan(b, {
    parent: plan, start: t, model: config.planner, system, messages: [userMsg],
    inputTokens: rng.int(620, 980), outputTokens: rng.int(140, 320),
    responseContent: [{ type: "text", text: `I'll search for ${topic.queries.length} angles on this, then read the strongest sources.` }, ...planToolUses],
    stopReason: "tool_use", tools,
  });
  b.patch(plan, { end: t + rng.int(1, 6), output: { queries: topic.queries } });
  t += rng.int(5, 25);

  // 2. one search step per query, then any follow-up loops
  const summaries: string[] = [];
  const queries = [...topic.queries, ...(opts.followUpQueries ?? [])];
  for (const [qi, q] of queries.entries()) {
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
    const synthInput = opts.synthInputTokens ?? rng.int(3200, 7600);

    if (opts.incident === "context_overflow_fatal") {
      fatal = { type: "invalid_request_error", message: `prompt is too long: 212417 tokens > 200000 maximum for ${config.synthesizer.id}` };
      t = llmSpan(b, { parent: step, start: t, model: config.synthesizer, system, messages, inputTokens: 0, outputTokens: 0, responseContent: [], stopReason: "end_turn", error: fatal });
    } else {
      const overloadAttempts = opts.incident === "synth_overloaded_fatal" ? (opts.synthAttempts ?? 2) : 0;
      for (let a = 0; a < overloadAttempts; a++) {
        t = llmSpan(b, {
          parent: step, start: t, model: config.synthesizer, system, messages, inputTokens: 0, outputTokens: 0, responseContent: [], stopReason: "end_turn",
          error: { type: "overloaded_error", message: "529: Overloaded" },
        });
        t += 1000 * 2 ** a + rng.int(0, 250);
      }
      if (overloadAttempts > 0) {
        fatal = { type: "overloaded_error", message: `synthesize gave up after ${overloadAttempts} ${overloadAttempts === 1 ? "attempt" : "attempts"}: 529 Overloaded` };
      } else {
        t = llmSpan(b, {
          parent: step, start: t, model: config.synthesizer, system, messages,
          inputTokens: synthInput, outputTokens: rng.int(380, 900),
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

// ---------------------------------------------------------------- run transforms

/** Gives a run fresh trace and span ids (two runs generated from one seed share ids). */
export function withFreshIds(run: GeneratedRun, seed: number): GeneratedRun {
  const rng = createRng(seed);
  const traceId = rng.hex(32);
  const ids = new Map(run.spans.map((s) => [s.spanId, rng.hex(16)]));
  return {
    traceId,
    status: run.status,
    spans: run.spans.map((s) => ({
      ...s,
      traceId,
      spanId: ids.get(s.spanId)!,
      parentSpanId: s.parentSpanId ? (ids.get(s.parentSpanId) ?? null) : null,
    })),
  };
}

/** Steps are the root's `custom` children, numbered from 1 in start order (as the SDK's replay counts them). */
function stepsOf(run: GeneratedRun): GeneratedSpan[] {
  const root = run.spans.find((s) => s.parentSpanId === null);
  return run.spans
    .filter((s) => s.parentSpanId === root?.spanId && s.kind === "custom")
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/**
 * Turns `live` (a run generated with the same seed as `original`, so its early
 * steps match the recording) into what `tracewright.replay(original, from_step)`
 * records: steps before `fromStep` are served from the recording (marked
 * replayed, near-instant, no LLM spend), and the rest ran live.
 */
export function asReplay(original: GeneratedRun, live: GeneratedRun, fromStep: number, overrides: Record<string, JsonValue>): GeneratedRun {
  const run = structuredClone(live);
  const root = run.spans.find((s) => s.parentSpanId === null)!;
  root.attributes = {
    ...root.attributes,
    "tracewright.replay_of": original.traceId,
    "tracewright.replay_from_step": fromStep,
    "tracewright.replay_tools": "recorded",
    "tracewright.replay_overrides": overrides,
  };

  const steps = stepsOf(run);
  const served = steps.slice(0, fromStep - 1);
  const firstLive = steps[fromStep - 1];
  if (!firstLive) return run;

  // Re-time the served steps: each recorded call returns in a millisecond or two.
  let cursor = Date.parse(root.startTime) + 4;
  const set = (s: GeneratedSpan, start: number, end: number) => {
    s.startTime = new Date(start).toISOString();
    s.endTime = new Date(end).toISOString();
    s.durationMs = end - start;
  };
  for (const step of served) {
    const stepStart = cursor;
    cursor += 1;
    const calls = run.spans.filter((s) => s.parentSpanId === step.spanId).sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (const [i, call] of calls.entries()) {
      const d = 1 + (i % 3);
      set(call, cursor, cursor + d);
      cursor += d + 1;
      // Same seed, same span order: the recorded call sits at the same position in the original.
      const source = original.spans[run.spans.indexOf(call)]?.spanId ?? null;
      call.attributes = { ...call.attributes, "tracewright.replayed": true, "tracewright.replay_source_span_id": source };
      if (call.kind === "llm") {
        call.attributes["tracewright.cost_usd"] = 0; // nothing was spent this time
        call.costUsd = 0;
      }
    }
    set(step, stepStart, cursor);
    step.attributes = { ...step.attributes, "tracewright.replayed": true };
    cursor += 2;
  }

  // Everything from the first live step on keeps its shape, shifted earlier.
  const servedIds = new Set(served.flatMap((s) => [s.spanId, ...run.spans.filter((c) => c.parentSpanId === s.spanId).map((c) => c.spanId)]));
  const shift = Date.parse(firstLive.startTime) - cursor;
  for (const s of run.spans) {
    if (s === root || servedIds.has(s.spanId)) continue;
    set(s, Date.parse(s.startTime) - shift, Date.parse(s.endTime) - shift);
  }
  const end = Math.max(...run.spans.filter((s) => s !== root).map((s) => Date.parse(s.endTime))) + 2;
  set(root, Date.parse(root.startTime), end);
  return run;
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
 * The demo project's baseline: every topic under prompt v1 and v2, spread over
 * the 14 days before `anchorMs`, newest last.
 */
export function generateDemoRuns(anchorMs: number, prices: PriceTable, seed = 20261027): GeneratedRun[] {
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
    runs.push(generateRun({ topic, promptVersion, config, startMs, incident: INCIDENTS[index] ?? "none", tags, seed: seed + index * 7919, prices }));
  }
  return runs;
}

const topicByTitle = (title: string): Topic => {
  const topic = TOPICS.find((t) => t.title === title);
  if (!topic) throw new Error(`unknown topic: ${title}`);
  return topic;
};

export interface DiffPair {
  label: string;
  baseline: GeneratedRun;
  candidate: GeneratedRun;
}

/**
 * Three before/after pairs that make instructive diffs. In each pair both runs
 * come from the same seed, so they are identical up to the change being shown.
 */
export function generateDiffPairs(anchorMs: number, prices: PriceTable): DiffPair[] {
  const hour = 3600_000;

  // 1. Model swap fixes an error: Haiku's context window overflows at synthesis; Sonnet's doesn't.
  const swapTopic = topicByTitle("llm eval contamination");
  const swapBase = { topic: swapTopic, promptVersion: "v2" as const, startMs: anchorMs - 30 * hour, seed: 5101, prices, tags: ["eval", "prompt-v2"] };
  const swapA = generateRun({ ...swapBase, config: { planner: MODELS.sonnet, summarizer: MODELS.haiku, synthesizer: MODELS.haiku }, incident: "context_overflow_fatal" });
  const swapB = withFreshIds(
    generateRun({
      ...swapBase,
      startMs: anchorMs - 29 * hour,
      config: { planner: MODELS.sonnet, summarizer: MODELS.haiku, synthesizer: MODELS.sonnet },
      incident: "none",
      synthInputTokens: 212_417,
      tags: ["eval", "prompt-v2", "model-swap"],
    }),
    5102,
  );

  // 2. A prompt change that makes the agent keep looping: three extra searches, about 3x the cost.
  const loopTopic = topicByTitle("vector index recall tradeoffs");
  const loopBase = { topic: loopTopic, config: CONFIGS[0]!, incident: "none" as const, seed: 5201, prices };
  const loopA = generateRun({ ...loopBase, promptVersion: "v2", startMs: anchorMs - 20 * hour, tags: ["eval", "prompt-v2"] });
  const loopB = withFreshIds(
    generateRun({
      ...loopBase,
      promptVersion: "v2",
      startMs: anchorMs - 19 * hour,
      tags: ["eval", "prompt-v3"],
      followUpQueries: ["hnsw recall benchmark primary source", "pgvector ef_search latency measurements 2026", "hnsw parameter tuning independent replication"],
      synthInputTokens: 24_000,
    }),
    5202,
  );

  // 3. Replay: synthesis was overloaded; replay from that step with a different model.
  const replayTopic = topicByTitle("kafka vs nats for event fanout");
  const replayBase = { topic: replayTopic, promptVersion: "v2" as const, seed: 5301, prices, tags: ["prod", "prompt-v2"] };
  const original = generateRun({ ...replayBase, config: CONFIGS[0]!, startMs: anchorMs - 8 * hour, incident: "synth_overloaded_fatal", synthAttempts: 1 });
  const live = withFreshIds(
    generateRun({ ...replayBase, config: { ...CONFIGS[0]!, synthesizer: MODELS.opus }, startMs: anchorMs - 7 * hour, incident: "none", tags: ["prod", "prompt-v2", "replay"] }),
    5302,
  );
  const fromStep = stepsOf(original).findIndex((s) => s.name === "synthesize") + 1;
  const replay = asReplay(original, live, fromStep, { model: MODELS.opus.id });

  return [
    { label: "Model swap fixes a context overflow", baseline: swapA, candidate: swapB },
    { label: "Extra search loop", baseline: loopA, candidate: loopB },
    { label: "Replay from synthesis on another model", baseline: original, candidate: replay },
  ];
}

/** A single representative run (with a recovered tool timeout) for the landing page hero. */
export function generateHeroRun(prices: PriceTable): GeneratedRun {
  return generateRun({
    topic: topicByTitle("solar payback in seattle"),
    promptVersion: "v2",
    config: CONFIGS[1]!,
    startMs: Date.UTC(2026, 9, 20, 14, 2, 11),
    incident: "search_timeout_recovered",
    tags: ["eval", "prompt-v2"],
    seed: 4242,
    prices,
  });
}
