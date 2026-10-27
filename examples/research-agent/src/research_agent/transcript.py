"""Provider-neutral conversation types shared by the agent loop and every backend."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class UserMessage:
    text: str


@dataclass(frozen=True)
class AssistantTurn:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    # The provider-native message, replayed verbatim by the backend that produced it
    # (Anthropic thinking blocks must be passed back unchanged).
    raw: Any = None


@dataclass(frozen=True)
class ToolResults:
    results: list[ToolResult]


Message = UserMessage | AssistantTurn | ToolResults


def to_chat_messages(transcript: Sequence[Message]) -> list[dict[str, Any]]:
    """Render a transcript in the familiar role/content shape, for traces and text prompts."""
    rendered: list[dict[str, Any]] = []
    for message in transcript:
        if isinstance(message, UserMessage):
            rendered.append({"role": "user", "content": message.text})
        elif isinstance(message, AssistantTurn):
            entry: dict[str, Any] = {"role": "assistant", "content": message.text}
            if message.tool_calls:
                entry["tool_calls"] = [
                    {"id": c.id, "name": c.name, "arguments": c.arguments}
                    for c in message.tool_calls
                ]
            rendered.append(entry)
        else:
            rendered.extend(
                {
                    "role": "tool",
                    "tool_call_id": r.call_id,
                    "name": r.name,
                    "content": r.content,
                    "is_error": r.is_error,
                }
                for r in message.results
            )
    return rendered
