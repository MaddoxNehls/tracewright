"""Real-provider backends exercised offline with fake clients and a fake subprocess."""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace
from typing import Any

import pytest
from tracewright.testing import InMemoryExporter

from research_agent.agent import ResearchAgent
from research_agent.backends import BackendError, create_backend
from research_agent.backends.anthropic_backend import AnthropicBackend
from research_agent.backends.claude_cli import ClaudeCliBackend, parse_reply
from research_agent.backends.openrouter_backend import OpenRouterBackend


class ScriptedCreate:
    """Stands in for ``messages.create`` / ``chat.completions.create``."""

    def __init__(self, *responses: Any) -> None:
        self._responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        return self._responses.pop(0)


def block(**fields: Any) -> SimpleNamespace:
    return SimpleNamespace(**fields)


def anthropic_message(stop_reason: str, *content: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        id="msg",
        model="claude-opus-5-5",
        stop_reason=stop_reason,
        content=list(content),
        usage=SimpleNamespace(input_tokens=50, output_tokens=10),
    )


def test_anthropic_backend_runs_a_tool_loop(exporter: InMemoryExporter) -> None:
    thinking = block(type="thinking", thinking="", signature="sig")
    messages = ScriptedCreate(
        anthropic_message(
            "tool_use",
            thinking,
            block(type="text", text="Searching."),
            block(type="tool_use", id="toolu_1", name="search_corpus", input={"query": "Gagarin"}),
        ),
        anthropic_message("end_turn", block(type="text", text="April 12, 1961.")),
    )
    backend = AnthropicBackend(client=SimpleNamespace(messages=messages))

    result = ResearchAgent(backend).run("When did Gagarin fly?")

    assert result.answer == "April 12, 1961."
    second = messages.requests[1]
    assert second["model"] == "claude-opus-5-5"
    assert "temperature" not in second
    assistant, tool_results = second["messages"][1], second["messages"][2]
    assert assistant["content"][0] is thinking  # raw content replayed unchanged
    assert tool_results["content"][0]["type"] == "tool_result"
    assert tool_results["content"][0]["tool_use_id"] == "toolu_1"
    llm = exporter.by_name("chat claude-opus-5-5")
    assert len(llm) == 2
    assert llm[0]["attributes"]["gen_ai.provider.name"] == "anthropic"


def test_anthropic_refusal_raises(exporter: InMemoryExporter) -> None:
    messages = ScriptedCreate(anthropic_message("refusal"))
    backend = AnthropicBackend(client=SimpleNamespace(messages=messages))

    with pytest.raises(BackendError, match="refusal"):
        ResearchAgent(backend).run("?")


def openai_completion(content: str | None, tool_calls: list[Any] | None = None) -> Any:
    message = SimpleNamespace(role="assistant", content=content, tool_calls=tool_calls)
    finish = "tool_calls" if tool_calls else "stop"
    return SimpleNamespace(
        id="gen",
        model="anthropic/claude-opus-5.5",
        choices=[SimpleNamespace(index=0, message=message, finish_reason=finish)],
        usage=SimpleNamespace(prompt_tokens=40, completion_tokens=8),
    )


def openai_tool_call(call_id: str, name: str, arguments: str) -> Any:
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=arguments))


def test_openrouter_backend_runs_a_tool_loop(exporter: InMemoryExporter) -> None:
    completions = ScriptedCreate(
        openai_completion(None, [openai_tool_call("c1", "calculator", '{"expression": "2+2"}')]),
        openai_completion(None, [openai_tool_call("c2", "calculator", "{not json")]),
        openai_completion("4"),
    )
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

    result = ResearchAgent(OpenRouterBackend(client=client)).run("2+2?")

    assert result.answer == "4"
    final_request = completions.requests[2]["messages"]
    assert final_request[0]["role"] == "system"
    assert final_request[2]["tool_calls"][0]["function"]["arguments"] == '{"expression": "2+2"}'
    assert final_request[3] == {"role": "tool", "tool_call_id": "c1", "content": "4"}
    assert final_request[5]["content"].startswith("TypeError")  # malformed JSON surfaced
    llm = exporter.by_name("chat anthropic/claude-opus-5.5")[0]
    assert llm["attributes"]["gen_ai.provider.name"] == "openrouter"


def test_openrouter_requires_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(BackendError, match="OPENROUTER_API_KEY"):
        OpenRouterBackend()


class FakeClaude:
    """Fake ``subprocess.run`` for the claude CLI, replaying protocol replies."""

    def __init__(self, *replies: str) -> None:
        self._replies = list(replies)
        self.commands: list[list[str]] = []
        self.prompts: list[str] = []

    def __call__(self, command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.commands.append(command)
        self.prompts.append(kwargs["input"])
        payload = {
            "type": "result",
            "is_error": False,
            "result": self._replies.pop(0),
            "total_cost_usd": 0.0123,
            "usage": {"input_tokens": 10, "cache_read_input_tokens": 1000, "output_tokens": 25},
            "modelUsage": {"claude-opus-5-5": {}},
        }
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload), stderr="")


def test_claude_cli_backend_records_manual_llm_spans(
    exporter: InMemoryExporter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")
    fake = FakeClaude(
        '{"thought": "Search first.", "tool_calls": [{"name": "search_corpus", '
        '"arguments": {"query": "Explorer 1"}}]}',
        '```json\n{"answer": "January 31, 1958."}\n```',
    )

    result = ResearchAgent(ClaudeCliBackend(runner=fake)).run("When did Explorer 1 launch?")

    assert result.answer == "January 31, 1958."
    assert fake.commands[0][1:] == [
        "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
    ]  # fmt: skip
    assert "TOOL RESULT (search_corpus, OK)" in fake.prompts[1]
    llm = exporter.by_name("chat claude-cli-default")
    assert len(llm) == 2
    attributes = llm[0]["attributes"]
    assert attributes["gen_ai.provider.name"] == "claude-cli"
    assert attributes["gen_ai.usage.input_tokens"] == 1010
    assert attributes["gen_ai.usage.output_tokens"] == 25
    assert attributes["gen_ai.response.model"] == "claude-opus-5-5"
    assert attributes["tracewright.cost_usd"] == pytest.approx(0.0123)


def test_claude_cli_failure_raises_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("shutil.which", lambda name: name)

    def failing(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="not logged in")

    with pytest.raises(BackendError, match="not logged in"):
        ClaudeCliBackend(runner=failing).complete("system", [], [])


def test_claude_cli_rejects_unsafe_model_names() -> None:
    with pytest.raises(ValueError, match="invalid model"):
        ClaudeCliBackend(model="opus & del *")


@pytest.mark.parametrize(
    ("text", "answer", "tool_names"),
    [
        ('{"answer": "42"}', "42", []),
        ('Sure! {"thought": "t", "tool_calls": [{"name": "calculator"}]}', "t", ["calculator"]),
        ("Plain prose, no JSON.", "Plain prose, no JSON.", []),
        ('{"broken": ', '{"broken":', []),
    ],
)
def test_parse_reply(text: str, answer: str, tool_names: list[str]) -> None:
    turn = parse_reply(text, turn=0)
    assert turn.text == answer
    assert [c.name for c in turn.tool_calls] == tool_names


def test_create_backend_rejects_unknown_names() -> None:
    with pytest.raises(ValueError, match="unknown backend"):
        create_backend("gpt-local")
