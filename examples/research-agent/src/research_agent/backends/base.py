from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from research_agent.tools import ToolSpec
from research_agent.transcript import AssistantTurn, Message


class BackendError(RuntimeError):
    """The LLM backend failed or returned something the agent cannot use."""


class Backend(Protocol):
    """One LLM provider. ``complete`` returns the model's next turn for the transcript."""

    name: str
    model: str

    def complete(
        self, system: str, transcript: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> AssistantTurn: ...
