"""End-to-end mock runs, asserting the shape of the recorded span tree."""

from __future__ import annotations

from typing import Any

import pytest
from tracewright.testing import InMemoryExporter

from research_agent.agent import MaxStepsExceeded, ResearchAgent
from research_agent.backends import MockBackend


def shape(exporter: InMemoryExporter, span: dict[str, Any]) -> list[Any]:
    """Children as (kind, name, status) tuples, with nested children for step spans."""
    out: list[Any] = []
    for child in exporter.children_of(span["span_id"]):
        node: tuple[Any, ...] = (child["kind"], child["name"], child["status"])
        grandchildren = shape(exporter, child)
        out.append((*node, grandchildren) if grandchildren else node)
    return out


LLM = ("llm", "chat mock-1", "ok")


def tool(name: str, status: str = "ok") -> tuple[str, str, str]:
    return ("tool", name, status)


def step(n: int, *children: tuple[str, str, str]) -> tuple[Any, ...]:
    return ("custom", f"step-{n}", "ok", [LLM, *children])


def run_scenario(scenario: str) -> tuple[ResearchAgent, Any]:
    agent = ResearchAgent(MockBackend(scenario), tags=[f"scenario:{scenario}"])
    return agent, agent.run(MockBackend(scenario).scenario.question)


def test_apollo_gap_run_produces_expected_tree(exporter: InMemoryExporter) -> None:
    agent, result = run_scenario("apollo-gap")

    (root,) = exporter.roots()
    assert root["kind"] == "agent"
    assert root["name"] == "research-agent"
    assert root["status"] == "ok"
    assert root["trace_id"] == result.trace_id
    assert root["attributes"]["tracewright.tags"] == [
        "research-agent",
        "backend:mock",
        "scenario:apollo-gap",
    ]
    assert root["output"] == {"answer": result.answer, "steps": 5}
    assert shape(exporter, root) == [
        step(1, tool("search_corpus")),
        step(2, tool("search_corpus")),
        step(3, tool("calculator")),
        step(4, tool("save_note")),
        ("custom", "step-5", "ok", [LLM]),
    ]
    assert {s["trace_id"] for s in exporter.spans} == {result.trace_id}
    assert "12 calendar years" in result.answer
    assert agent.toolbox.notes[0].title == "Sputnik 1 to Apollo 11"


def test_llm_spans_carry_genai_attributes_and_transcript(exporter: InMemoryExporter) -> None:
    run_scenario("apollo-gap")

    llm_spans = exporter.by_name("chat mock-1")
    assert len(llm_spans) == 5
    first, last = llm_spans[0], llm_spans[-1]
    assert first["attributes"]["gen_ai.provider.name"] == "mock"
    assert first["attributes"]["gen_ai.response.finish_reasons"] == ["tool_use"]
    assert last["attributes"]["gen_ai.response.finish_reasons"] == ["end_turn"]
    assert first["attributes"]["gen_ai.usage.input_tokens"] > 0
    # The transcript grows step by step, and earlier inputs are not mutated afterwards.
    assert len(first["input"]["messages"]) == 1
    assert len(last["input"]["messages"]) == 9


def test_agent_recovers_from_a_tool_error(exporter: InMemoryExporter) -> None:
    _, result = run_scenario("calculator-recovery")

    (root,) = exporter.roots()
    assert root["status"] == "ok"
    assert shape(exporter, root) == [
        step(1, tool("search_corpus")),
        step(2, tool("search_corpus")),
        step(3, tool("calculator", "error")),
        step(4, tool("calculator")),
        ("custom", "step-5", "ok", [LLM]),
    ]
    failed = next(s for s in exporter.by_name("calculator") if s["status"] == "error")
    assert failed["error"]["type"] == "CalculatorError"
    # The error was fed back to the model as a tool result.
    retry_llm = exporter.by_name("chat mock-1")[3]
    assert retry_llm["input"]["messages"][-1]["is_error"] is True
    assert "5.6%" in result.answer


def test_parallel_tool_calls_share_a_step(exporter: InMemoryExporter) -> None:
    _, result = run_scenario("parallel-lookup")

    (root,) = exporter.roots()
    assert shape(exporter, root) == [
        step(1, tool("search_corpus"), tool("search_corpus")),
        step(2, tool("calculator")),
        ("custom", "step-3", "ok", [LLM]),
    ]
    assert "23 days" in result.answer


def test_exceeding_max_steps_marks_the_run_as_error(exporter: InMemoryExporter) -> None:
    agent = ResearchAgent(MockBackend("apollo-gap"), max_steps=2)

    with pytest.raises(MaxStepsExceeded):
        agent.run("anything")

    (root,) = exporter.roots()
    assert root["status"] == "error"
    assert root["error"]["type"] == "MaxStepsExceeded"
    assert len(exporter.children_of(root["span_id"])) == 2
