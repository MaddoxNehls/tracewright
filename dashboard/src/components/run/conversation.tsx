"use client";

import { Wrench } from "lucide-react";
import { useState } from "react";
import type { ChatBlock, ChatMessage, Transcript } from "@/lib/llm-messages";
import { JsonView } from "../json-view";

const ROLE_LABEL: Record<string, string> = { user: "User", assistant: "Assistant", tool: "Tool" };

export function Conversation({ transcript }: { transcript: Transcript }) {
  const { system, messages, response, stopReason } = transcript;
  if (!system && messages.length === 0 && !response) {
    return <p className="text-[13px] text-fg-muted">This span didn&apos;t record any messages.</p>;
  }

  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation">
      {system && (
        <li>
          <SystemPrompt text={system} />
        </li>
      )}
      {messages.map((m, i) => (
        <li key={i}>
          <MessageCard message={m} />
        </li>
      ))}
      {response ? (
        <li>
          <MessageCard message={response} isResponse stopReason={stopReason} />
        </li>
      ) : (
        <li className="rounded-md border border-dashed border-err-border px-3 py-2 text-[12.5px] text-err">No response: the call failed before the model replied.</li>
      )}
    </ol>
  );
}

function SystemPrompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className="rounded-md border border-border bg-surface-2/50 px-3 py-2">
      <div className="mb-1 text-[11.5px] font-medium text-fg-subtle">System prompt</div>
      <p className={`whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-muted ${!open && long ? "line-clamp-3" : ""}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-[12px] font-medium text-fg-muted hover:text-fg">
          {open ? "Show less" : "Show full prompt"}
        </button>
      )}
    </div>
  );
}

function MessageCard({ message, isResponse, stopReason }: { message: ChatMessage; isResponse?: boolean; stopReason?: string | null }) {
  const isAssistant = message.role === "assistant";
  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${
        isResponse ? "border-kind-llm/50 bg-kind-llm/[0.06]" : isAssistant ? "border-border bg-surface-2/40" : "border-border bg-surface"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px]">
        <span className={`font-medium ${isResponse ? "text-kind-llm" : "text-fg-subtle"}`}>
          {isResponse ? "Response" : (ROLE_LABEL[message.role] ?? message.role)}
        </span>
        {isResponse && stopReason && <span className="text-fg-subtle">stop: {stopReason}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {message.blocks.length === 0 ? <span className="text-[12.5px] text-fg-subtle">(empty)</span> : message.blocks.map((b, i) => <Block key={i} block={b} />)}
      </div>
    </div>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.type) {
    case "text":
      return <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">{block.text}</p>;
    case "tool_use":
      return (
        <div className="rounded border border-kind-tool/40 bg-kind-tool/[0.06] px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-kind-tool">
            <Wrench className="size-3.5" aria-hidden />
            Calls <span className="font-mono">{block.name}</span>
          </div>
          <JsonView value={block.input} openDepth={2} />
        </div>
      );
    case "tool_result":
      return (
        <div className={`rounded border px-2.5 py-2 ${block.isError ? "border-err-border bg-err-soft" : "border-border bg-surface-2/60"}`}>
          <div className="mb-1 text-[11.5px] font-medium text-fg-subtle">Tool result</div>
          <p className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg-muted">{block.content}</p>
        </div>
      );
    case "json":
      return <JsonView value={block.value} openDepth={2} />;
  }
}
