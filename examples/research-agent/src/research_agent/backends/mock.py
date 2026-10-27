"""A scripted, deterministic backend that produces realistic traces without an API key."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import tracewright

from research_agent.tools import ToolSpec
from research_agent.transcript import (
    AssistantTurn,
    Message,
    ToolCall,
    ToolResults,
    to_chat_messages,
)

ScriptStep = Callable[[Sequence[Message]], AssistantTurn]


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    question: str
    steps: tuple[ScriptStep, ...]


def _turn_index(transcript: Sequence[Message]) -> int:
    return sum(isinstance(m, AssistantTurn) for m in transcript)


def call(text: str, *tools: tuple[str, dict[str, Any]]) -> ScriptStep:
    def step(transcript: Sequence[Message]) -> AssistantTurn:
        n = _turn_index(transcript) + 1
        calls = [ToolCall(f"call_{n}_{i}", name, args) for i, (name, args) in enumerate(tools)]
        return AssistantTurn(text, calls)

    return step


def answer(template: str) -> ScriptStep:
    """Final answer; ``{calc}`` is the last successful calculator result in the transcript."""

    def step(transcript: Sequence[Message]) -> AssistantTurn:
        return AssistantTurn(template.format(calc=_last_calculation(transcript)))

    return step


def _last_calculation(transcript: Sequence[Message]) -> Any:
    for message in reversed(transcript):
        if isinstance(message, ToolResults):
            for result in message.results:
                if result.name == "calculator" and not result.is_error:
                    return json.loads(result.content)
    return float("nan")


SCENARIOS = {
    s.name: s
    for s in [
        Scenario(
            "apollo-gap",
            "Two searches, a calculation and a saved note before answering.",
            "How many years passed between the launch of Sputnik 1 and the first crewed "
            "Moon landing, and who first walked on the Moon?",
            (
                call(
                    "I'll start by finding when Sputnik 1 launched.",
                    ("search_corpus", {"query": "Sputnik 1 launch date"}),
                ),
                call(
                    "Sputnik 1 launched on October 4, 1957. Next, the first Moon landing.",
                    ("search_corpus", {"query": "Apollo 11 first Moon landing walk"}),
                ),
                call(
                    "Apollo 11 landed on July 20, 1969. Computing the gap in calendar years.",
                    ("calculator", {"expression": "1969 - 1957"}),
                ),
                call(
                    "Saving this finding before answering.",
                    (
                        "save_note",
                        {
                            "title": "Sputnik 1 to Apollo 11",
                            "content": "Sputnik 1 launched 1957-10-04; Apollo 11 landed "
                            "1969-07-20. Neil Armstrong was first on the surface.",
                        },
                    ),
                ),
                answer(
                    "The Moon landing came {calc} calendar years after Sputnik 1: Sputnik 1 "
                    "launched on October 4, 1957, and Apollo 11's lunar module Eagle landed on "
                    "July 20, 1969 (just under 11 years and 10 months later). Neil Armstrong "
                    "was the first person to walk on the Moon, followed by Buzz Aldrin. "
                    "Sources: sputnik-1, apollo-11."
                ),
            ),
        ),
        Scenario(
            "calculator-recovery",
            "The calculator rejects an expression with units; the agent retries and recovers.",
            "What share of all the lunar samples returned by Apollo came back on Apollo 11?",
            (
                call(
                    "First, how much material did Apollo 11 bring back?",
                    ("search_corpus", {"query": "Apollo 11 lunar samples kilograms"}),
                ),
                call(
                    "Apollo 11 returned 21.5 kg. Now the program total.",
                    ("search_corpus", {"query": "Apollo program total lunar samples returned"}),
                ),
                call(
                    "All six landings returned about 382 kg. Calculating the share.",
                    ("calculator", {"expression": "21.5 kg / 382 kg * 100"}),
                ),
                call(
                    "The calculator does not accept units. Retrying with plain numbers.",
                    ("calculator", {"expression": "21.5 / 382 * 100"}),
                ),
                answer(
                    "Apollo 11 returned about {calc:.1f}% of all Apollo lunar samples: 21.5 kg "
                    "out of roughly 382 kg collected across the six landing missions. "
                    "Sources: apollo-11, apollo-program-summary."
                ),
            ),
        ),
        Scenario(
            "parallel-lookup",
            "Two searches issued in a single step, then a calculation.",
            "How many days after Yuri Gagarin's flight did Alan Shepard become the first "
            "American in space?",
            (
                call(
                    "I'll look up both flights at once.",
                    ("search_corpus", {"query": "Yuri Gagarin Vostok 1 date"}),
                    ("search_corpus", {"query": "Alan Shepard Freedom 7 first American"}),
                ),
                call(
                    "Gagarin flew on April 12, 1961 and Shepard on May 5, 1961. April has 30 "
                    "days, so I'll count the remaining April days plus five.",
                    ("calculator", {"expression": "(30 - 12) + 5"}),
                ),
                answer(
                    "Alan Shepard flew {calc} days after Yuri Gagarin: Vostok 1 launched on "
                    "April 12, 1961 and Freedom 7 on May 5, 1961. Shepard's flight was "
                    "suborbital and lasted 15 minutes 22 seconds, versus Gagarin's 108-minute "
                    "orbit. Sources: vostok-1-gagarin, mercury-program."
                ),
            ),
        ),
    ]
}

DEFAULT_SCENARIO = "apollo-gap"
_GIVE_UP = answer("I could not find a confident answer in the corpus.")


class MockBackend:
    """Replays a scenario, recording each turn as an ``llm`` span like a real provider."""

    name = "mock"

    def __init__(
        self, scenario: str = DEFAULT_SCENARIO, *, model: str = "mock-1", latency: float = 0.0
    ) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; choose from {sorted(SCENARIOS)}")
        self.scenario = SCENARIOS[scenario]
        self.model = model
        self._latency = latency

    def complete(
        self, system: str, transcript: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> AssistantTurn:
        index = _turn_index(transcript)
        request = {"system": system, "messages": to_chat_messages(transcript)}
        with tracewright.span(
            f"chat {self.model}",
            kind="llm",
            input=request,
            attributes={
                "gen_ai.provider.name": "mock",
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": self.model,
            },
        ) as span:
            steps = self.scenario.steps
            turn = (steps[index] if index < len(steps) else _GIVE_UP)(transcript)
            if self._latency:
                time.sleep(self._latency * (0.6 + 0.3 * (index % 3)))
            prompt_chars = len(json.dumps(request)) + sum(
                len(json.dumps(t.input_schema)) for t in tools
            )
            output = to_chat_messages([turn])[0]
            span.set_attributes(
                {
                    "gen_ai.response.model": self.model,
                    "gen_ai.usage.input_tokens": prompt_chars // 4,
                    "gen_ai.usage.output_tokens": max(1, len(json.dumps(output)) // 4),
                    "gen_ai.response.finish_reasons": [
                        "tool_use" if turn.tool_calls else "end_turn"
                    ],
                }
            )
            span.set_output(output)
        return turn
