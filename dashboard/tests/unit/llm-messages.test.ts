import { describe, expect, it } from "vitest";
import { toTranscript } from "@/lib/llm-messages";

describe("toTranscript", () => {
  it("reads Anthropic Messages payloads with content blocks", () => {
    const t = toTranscript(
      {
        system: "Be brief.",
        messages: [
          { role: "user", content: "What is 2+2?" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculator", input: { expression: "2+2" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "4" }] },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "4" }], stop_reason: "end_turn" },
    );
    expect(t.system).toBe("Be brief.");
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(t.messages[1]?.blocks[0]).toEqual({ type: "tool_use", name: "calculator", input: { expression: "2+2" } });
    expect(t.messages[2]?.blocks[0]).toEqual({ type: "tool_result", content: "4", isError: false });
    expect(t.response?.blocks).toEqual([{ type: "text", text: "4" }]);
    expect(t.stopReason).toBe("end_turn");
  });

  it("reads OpenAI-compatible payloads", () => {
    const t = toTranscript(
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", content: null, tool_calls: [{ function: { name: "search", arguments: JSON.stringify({ q: "x" }) } }] },
          },
        ],
      },
    );
    expect(t.system).toBe("sys");
    expect(t.messages).toEqual([{ role: "user", blocks: [{ type: "text", text: "hi" }] }]);
    expect(t.response?.blocks).toEqual([{ type: "tool_use", name: "search", input: { q: "x" } }]);
    expect(t.stopReason).toBe("tool_calls");
  });

  it("returns no response for a failed call and keeps unknown blocks as JSON", () => {
    const t = toTranscript({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }, null);
    expect(t.response).toBeNull();
    expect(t.messages[0]?.blocks[0]).toEqual({ type: "json", value: { type: "image", source: {} } });
  });
});
