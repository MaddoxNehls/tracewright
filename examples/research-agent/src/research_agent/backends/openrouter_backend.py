"""Any model on OpenRouter via the OpenAI SDK, auto-instrumented by Tracewright."""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from typing import Any

import tracewright

from research_agent.backends.base import BackendError
from research_agent.tools import ToolSpec
from research_agent.transcript import AssistantTurn, Message, ToolCall, ToolResults, UserMessage

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "anthropic/claude-opus-5.5"


class OpenRouterBackend:
    name = "openrouter"

    def __init__(self, model: str = DEFAULT_MODEL, *, client: Any = None) -> None:
        if client is None:
            import openai

            api_key = os.environ.get("OPENROUTER_API_KEY")
            if not api_key:
                raise BackendError("set OPENROUTER_API_KEY to use the openrouter backend")
            client = openai.OpenAI(base_url=OPENROUTER_BASE_URL, api_key=api_key)
        self._client = tracewright.instrument_openai(client, provider="openrouter")
        self.model = model

    def complete(
        self, system: str, transcript: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> AssistantTurn:
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for message in transcript:
            messages.extend(_to_openai(message))
        response = self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in tools
            ],
        )
        if not response.choices:
            raise BackendError("OpenRouter returned no choices")
        reply = response.choices[0].message
        calls = [
            ToolCall(tc.id, tc.function.name, _parse_arguments(tc.function.arguments))
            for tc in reply.tool_calls or []
        ]
        return AssistantTurn(reply.content or "", calls)


def _parse_arguments(raw: str | None) -> dict[str, Any]:
    # Malformed arguments are passed through so the tool call fails visibly and the
    # model gets a chance to correct itself.
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {"unparseable_arguments": raw}
    return parsed if isinstance(parsed, dict) else {"unparseable_arguments": raw}


def _to_openai(message: Message) -> list[dict[str, Any]]:
    if isinstance(message, UserMessage):
        return [{"role": "user", "content": message.text}]
    if isinstance(message, ToolResults):
        return [
            {"role": "tool", "tool_call_id": r.call_id, "content": r.content}
            for r in message.results
        ]
    entry: dict[str, Any] = {"role": "assistant", "content": message.text or None}
    if message.tool_calls:
        entry["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
            }
            for c in message.tool_calls
        ]
    return [entry]
