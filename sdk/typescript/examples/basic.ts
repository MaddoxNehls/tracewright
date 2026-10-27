/**
 * A tiny agent traced end to end, with a fake LLM client so it runs offline and costs nothing.
 *
 *   pnpm example                                   # prints the recorded span tree
 *   TRACEWRIGHT_API_KEY=tw_... pnpm example        # also ships spans to a local ingest service
 */

import { init, instrumentAnthropic, run, type SpanRecord, shutdown, trace } from "tracewright";
import { InMemoryExporter } from "tracewright/testing";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { expression: string } };

interface Message {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use";
  usage: { input_tokens: number; output_tokens: number };
}

// Stands in for `new Anthropic()`: first asks for a tool, then answers.
function fakeAnthropic() {
  let turn = 0;
  return {
    messages: {
      async create(params: { model: string; max_tokens: number; messages: unknown[] }): Promise<Message> {
        turn++;
        const base = { id: `msg_${turn}`, model: params.model, usage: { input_tokens: 40 * turn, output_tokens: 12 } };
        return turn === 1
          ? {
              ...base,
              content: [{ type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "6 * 7" } }],
              stop_reason: "tool_use",
            }
          : { ...base, content: [{ type: "text", text: "The answer is 42." }], stop_reason: "end_turn" };
      },
    },
  };
}

const calculator = trace(
  async (expression: string): Promise<number> => {
    const [a, b] = expression.split("*").map(Number);
    return (a ?? 0) * (b ?? 0);
  },
  { kind: "tool", name: "calculator" },
);

const recorder = new InMemoryExporter();
// With a key, spans go to the ingest service; without one, keep them in memory to print.
init(process.env["TRACEWRIGHT_API_KEY"] ? {} : { exporter: recorder });

const client = instrumentAnthropic(fakeAnthropic());
const model = "claude-sonnet-4-5";
const question = "What is six times seven?";

const answer = await run(
  "calculator-agent",
  async () => {
    const messages: unknown[] = [{ role: "user", content: question }];
    const first = await client.messages.create({ model, max_tokens: 256, messages });
    const result = await calculator("6 * 7");
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: String(result) });
    const final = await client.messages.create({ model, max_tokens: 256, messages });
    return final.content[0]?.type === "text" ? final.content[0].text : "";
  },
  { tags: ["example"], input: question },
);

await shutdown();
console.log(`answer: ${answer}\n`);

function printTree(spans: readonly SpanRecord[], parentId: string | null = null, depth = 0): void {
  const children = spans
    .filter((s) => s.parent_span_id === parentId)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  for (const s of children) {
    const ms = (Date.parse(s.end_time) - Date.parse(s.start_time)).toFixed(0);
    const tokens = s.attributes["gen_ai.usage.input_tokens"];
    const detail = tokens === undefined ? "" : ` tokens=${tokens}/${s.attributes["gen_ai.usage.output_tokens"]}`;
    console.log(`${"  ".repeat(depth)}${s.kind.padEnd(6)} ${s.name} [${s.status}] ${ms}ms${detail}`);
    printTree(spans, s.span_id, depth + 1);
  }
}

if (recorder.spans.length > 0) printTree(recorder.spans);
else console.log("spans sent to", process.env["TRACEWRIGHT_ENDPOINT"] ?? "http://localhost:4318");
