from __future__ import annotations

import json
from pathlib import Path

import pytest
from tracewright.testing import InMemoryExporter

from research_agent.corpus import Corpus, Document
from research_agent.tools import CalculatorError, Toolbox, evaluate
from research_agent.transcript import ToolCall


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("1969 - 1957", 12),
        ("21.5 / 382 * 100", 5.6282722513),
        ("(30 - 12) + 5", 23),
        ("2 ** 10", 1024),
        ("-3 + +4", 1),
        ("7 // 2 + 7 % 2", 4),
        ("1 / 4", 0.25),
    ],
)
def test_calculator_evaluates_arithmetic(expression: str, expected: float) -> None:
    assert evaluate(expression) == expected


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os').system('echo hi')",
        "open('x')",
        "1969 - year",
        "21.5 kg / 382 kg",
        "[1, 2]",
        "True + 1",
        "2 ** 1000",
        "1 / 0",
        "9" * 300,
    ],
)
def test_calculator_rejects_anything_else(expression: str) -> None:
    with pytest.raises(CalculatorError):
        evaluate(expression)


def test_bundled_corpus_loads() -> None:
    corpus = Corpus.bundled()
    assert len(corpus.documents) >= 20
    assert all(doc.title and doc.body for doc in corpus.documents)


@pytest.mark.parametrize(
    ("query", "expected_top"),
    [
        ("Sputnik 1 launch date", "sputnik-1"),
        ("first woman in space", "tereshkova-vostok-6"),
        ("Hubble mirror servicing", "hubble-space-telescope"),
        ("Voyager interstellar heliopause", "voyager-program"),
        ("oxygen tank explosion", "apollo-13"),
    ],
)
def test_search_ranks_the_relevant_document_first(query: str, expected_top: str) -> None:
    hits = Corpus.bundled().search(query)
    assert hits[0].doc_id == expected_top


def test_search_returns_best_paragraph_and_respects_limit() -> None:
    corpus = Corpus(
        [
            Document("a", "Rockets", "Intro paragraph.\n\nThe Saturn V had five F-1 engines."),
            Document("b", "Stations", "Skylab and Mir were space stations."),
        ]
    )
    hits = corpus.search("F-1 engines", limit=1)
    assert [h.doc_id for h in hits] == ["a"]
    assert hits[0].snippet == "The Saturn V had five F-1 engines."
    assert corpus.search("zzz unknown") == []


def test_toolbox_records_tool_spans(exporter: InMemoryExporter) -> None:
    toolbox = Toolbox()
    result = toolbox.execute(ToolCall("c1", "search_corpus", {"query": "Gagarin", "limit": 1}))

    assert not result.is_error
    assert json.loads(result.content)[0]["doc_id"] == "vostok-1-gagarin"
    (span,) = exporter.spans
    assert span["kind"] == "tool"
    assert span["name"] == "search_corpus"
    assert span["attributes"]["gen_ai.tool.name"] == "search_corpus"
    assert span["input"] == {"query": "Gagarin", "limit": 1}


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (
            ToolCall("c1", "calculator", {"expression": "1 / 0"}),
            "CalculatorError: division by zero",
        ),
        (ToolCall("c2", "calculator", {"expr": "1"}), "TypeError"),
        (ToolCall("c3", "launch_rocket", {}), "LookupError: unknown tool 'launch_rocket'"),
    ],
)
def test_tool_failures_become_error_results_and_error_spans(
    exporter: InMemoryExporter, call: ToolCall, message: str
) -> None:
    result = Toolbox().execute(call)

    assert result.is_error
    assert result.content.startswith(message)
    (span,) = exporter.spans
    assert span["status"] == "error"
    assert span["name"] == call.name


def test_save_note_keeps_notes_and_optionally_writes_files(tmp_path: Path) -> None:
    toolbox = Toolbox(notes_dir=tmp_path)
    result = toolbox.execute(
        ToolCall("c1", "save_note", {"title": "Apollo 11: Facts!", "content": "Landed 1969."})
    )

    assert not result.is_error
    assert toolbox.notes[0].title == "Apollo 11: Facts!"
    assert (tmp_path / "apollo-11-facts.md").read_text(encoding="utf-8").startswith("# Apollo 11")
