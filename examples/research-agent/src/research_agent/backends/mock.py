"""A scripted, deterministic backend that produces realistic traces without an API key.

The mock speaks the Anthropic Messages API: ``MockBackend`` is the real Anthropic backend
pointed at :class:`ScriptedAnthropic`, a fake client whose "model" follows a scenario
script. So mock runs go through the same Tracewright instrumentation, and the same
replay path, as production runs.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from research_agent.backends.anthropic_backend import AnthropicBackend
from research_agent.transcript import (
    AssistantTurn,
    Message,
    ToolCall,
    ToolResult,
    ToolResults,
    UserMessage,
    to_chat_messages,
)

CAREFUL_MODEL = "mock-2"


@dataclass(frozen=True)
class Prompt:
    """What the scripted model sees on one call."""

    system: str
    model: str
    transcript: Sequence[Message]

    @property
    def plain_numbers(self) -> bool:
        """Whether calculator expressions come out without units.

        The careful model always writes them that way; the default model only when the
        system prompt asks for plain numbers.
        """
        return self.model == CAREFUL_MODEL or "plain numbers" in self.system.lower()


ScriptStep = Callable[[Prompt], AssistantTurn]


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    question: str
    steps: tuple[ScriptStep, ...]


def _turn_index(transcript: Sequence[Message]) -> int:
    return sum(isinstance(m, AssistantTurn) for m in transcript)


def call(text: str, *tools: tuple[str, dict[str, Any]]) -> ScriptStep:
    def step(prompt: Prompt) -> AssistantTurn:
        n = _turn_index(prompt.transcript) + 1
        calls = [ToolCall(f"call_{n}_{i}", name, args) for i, (name, args) in enumerate(tools)]
        return AssistantTurn(text, calls)

    return step


def answer(template: str) -> ScriptStep:
    """Final answer; ``{calc}`` is the last successful calculator result in the transcript."""

    def step(prompt: Prompt) -> AssistantTurn:
        return AssistantTurn(template.format(calc=_last_calculation(prompt.transcript)))

    return step


def retry_if_failed(retry: ScriptStep, otherwise: ScriptStep) -> ScriptStep:
    """React to the previous tool results, as a model would."""

    def step(prompt: Prompt) -> AssistantTurn:
        return (retry if _last_results_failed(prompt.transcript) else otherwise)(prompt)

    return step


def _last_calculation(transcript: Sequence[Message]) -> Any:
    for message in reversed(transcript):
        if isinstance(message, ToolResults):
            for result in message.results:
                if result.name == "calculator" and not result.is_error:
                    return json.loads(result.content)
    return float("nan")


def _last_results_failed(transcript: Sequence[Message]) -> bool:
    last = transcript[-1] if transcript else None
    return isinstance(last, ToolResults) and any(r.is_error for r in last.results)


def _share_of_samples(prompt: Prompt) -> AssistantTurn:
    expression = "21.5 / 382 * 100" if prompt.plain_numbers else "21.5 kg / 382 kg * 100"
    return call(
        "All six landings returned about 382 kg. Calculating the share.",
        ("calculator", {"expression": expression}),
    )(prompt)


_SAMPLES_ANSWER = answer(
    "Apollo 11 returned about {calc:.1f}% of all Apollo lunar samples: 21.5 kg "
    "out of roughly 382 kg collected across the six landing missions. "
    "Sources: apollo-11, apollo-program-summary."
)

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
            "The calculator rejects an expression with units; the agent retries and recovers. "
            f"A system prompt asking for plain numbers (or --model {CAREFUL_MODEL}) avoids it.",
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
                _share_of_samples,
                retry_if_failed(
                    call(
                        "The calculator does not accept units. Retrying with plain numbers.",
                        ("calculator", {"expression": "21.5 / 382 * 100"}),
                    ),
                    otherwise=_SAMPLES_ANSWER,
                ),
                _SAMPLES_ANSWER,
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


class ScriptedAnthropic:
    """A fake ``anthropic.Anthropic`` whose model plays a scenario's script."""

    def __init__(self, scenario: Scenario, *, latency: float = 0.0) -> None:
        self.messages = _ScriptedMessages(scenario, latency)


class _ScriptedMessages:
    def __init__(self, scenario: Scenario, latency: float) -> None:
        self._scenario = scenario
        self._latency = latency

    def create(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, Any]],
        system: Any = "",
        tools: Sequence[Mapping[str, Any]] = (),
        **_: Any,
    ) -> Any:
        from anthropic.types import Message as AnthropicMessage

        transcript = _from_anthropic(messages)
        prompt = Prompt(_system_text(system), model, transcript)
        index = _turn_index(transcript)
        steps = self._scenario.steps
        turn = (steps[index] if index < len(steps) else _GIVE_UP)(prompt)
        if self._latency:
            time.sleep(self._latency * (0.6 + 0.3 * (index % 3)))

        content: list[dict[str, Any]] = [{"type": "text", "text": turn.text}] if turn.text else []
        content += [
            {"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments}
            for c in turn.tool_calls
        ]
        prompt_chars = len(prompt.system) + len(json.dumps(to_chat_messages(transcript)))
        prompt_chars += len(json.dumps(list(tools)))
        return AnthropicMessage.model_validate(
            {
                "id": f"msg_mock_{index + 1}",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": content,
                "stop_reason": "tool_use" if turn.tool_calls else "end_turn",
                "stop_sequence": None,
                "usage": {
                    "input_tokens": prompt_chars // 4,
                    "output_tokens": max(1, len(json.dumps(content)) // 4),
                },
            }
        )


def _get(block: Any, key: str) -> Any:
    """Read a content block that may be a dict or an SDK model."""
    return block.get(key) if isinstance(block, Mapping) else getattr(block, key, None)


def _system_text(system: Any) -> str:
    if isinstance(system, list):
        return "\n\n".join(str(_get(b, "text") or "") for b in system)
    return str(system or "")


def _from_anthropic(messages: Sequence[Mapping[str, Any]]) -> list[Message]:
    """Rebuild the provider-neutral transcript the scenario scripts reason about."""
    transcript: list[Message] = []
    tool_names: dict[str, str] = {}
    for message in messages:
        content = message["content"]
        if message["role"] == "assistant":
            text = "".join(_get(b, "text") or "" for b in content if _get(b, "type") == "text")
            calls = [
                ToolCall(_get(b, "id"), _get(b, "name"), dict(_get(b, "input")))
                for b in content
                if _get(b, "type") == "tool_use"
            ]
            tool_names.update((c.id, c.name) for c in calls)
            transcript.append(AssistantTurn(text, calls))
        elif isinstance(content, str):
            transcript.append(UserMessage(content))
        else:
            results = [
                ToolResult(
                    _get(b, "tool_use_id"),
                    tool_names.get(_get(b, "tool_use_id"), ""),
                    str(_get(b, "content")),
                    bool(_get(b, "is_error")),
                )
                for b in content
                if _get(b, "type") == "tool_result"
            ]
            transcript.append(ToolResults(results))
    return transcript


class MockBackend(AnthropicBackend):
    """The Anthropic backend, driven by a scripted model instead of the API."""

    name = "mock"

    def __init__(
        self, scenario: str = DEFAULT_SCENARIO, *, model: str = "mock-1", latency: float = 0.0
    ) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; choose from {sorted(SCENARIOS)}")
        self.scenario = SCENARIOS[scenario]
        super().__init__(
            model,
            client=ScriptedAnthropic(self.scenario, latency=latency),
            max_tokens=1024,
            provider="mock",
        )
