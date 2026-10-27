"""Claude via the Anthropic SDK, auto-instrumented by Tracewright."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import tracewright

from research_agent.backends.base import BackendError
from research_agent.tools import ToolSpec
from research_agent.transcript import AssistantTurn, Message, ToolCall, ToolResults, UserMessage

DEFAULT_MODEL = "claude-opus-5-5"


class AnthropicBackend:
    name = "anthropic"

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        client: Any = None,
        max_tokens: int = 16000,
        provider: str = "anthropic",
    ) -> None:
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self._client = tracewright.instrument_anthropic(client, provider=provider)
        self.model = model
        self._max_tokens = max_tokens

    def complete(
        self, system: str, transcript: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> AssistantTurn:
        response = self._client.messages.create(
            model=self.model,
            max_tokens=self._max_tokens,
            system=system,
            tools=[
                {"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in tools
            ],
            messages=[_to_anthropic(m) for m in transcript],
        )
        if response.stop_reason == "refusal":
            raise BackendError("the model declined to answer (stop_reason=refusal)")
        text = "".join(b.text for b in response.content if b.type == "text")
        calls = [
            ToolCall(b.id, b.name, dict(b.input)) for b in response.content if b.type == "tool_use"
        ]
        if not calls and response.stop_reason == "max_tokens":
            raise BackendError("response hit max_tokens before finishing")
        return AssistantTurn(text, calls, raw=response.content)


def _to_anthropic(message: Message) -> dict[str, Any]:
    if isinstance(message, UserMessage):
        return {"role": "user", "content": message.text}
    if isinstance(message, ToolResults):
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": r.call_id,
                    "content": r.content,
                    "is_error": r.is_error,
                }
                for r in message.results
            ],
        }
    if message.raw is not None:
        return {"role": "assistant", "content": message.raw}
    blocks: list[dict[str, Any]] = [{"type": "text", "text": message.text}] if message.text else []
    blocks += [
        {"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments}
        for c in message.tool_calls
    ]
    return {"role": "assistant", "content": blocks}
