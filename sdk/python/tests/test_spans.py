from __future__ import annotations

import asyncio
import re
from datetime import datetime

import pytest

import tracewright
from tracewright.testing import InMemoryExporter

HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")
RFC3339_NANO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$")


def test_run_creates_root_agent_span_matching_contract(exporter: InMemoryExporter) -> None:
    with tracewright.run("research", tags=["demo", "v1"], input={"q": "why?"}) as run:
        run.set_output("because")

    (root,) = exporter.spans
    assert set(root) == {
        "trace_id", "span_id", "parent_span_id", "name", "kind", "start_time",
        "end_time", "status", "error", "attributes", "input", "output",
    }  # fmt: skip
    assert HEX32.match(root["trace_id"])
    assert HEX16.match(root["span_id"])
    assert root["parent_span_id"] is None
    assert root["kind"] == "agent"
    assert root["status"] == "ok"
    assert root["error"] is None
    assert root["attributes"]["tracewright.tags"] == ["demo", "v1"]
    assert root["input"] == {"q": "why?"}
    assert root["output"] == "because"
    assert RFC3339_NANO.match(root["start_time"])
    assert root["end_time"] >= root["start_time"]
    assert datetime.fromisoformat(root["start_time"][:26] + "+00:00")


def test_nested_spans_form_a_tree(exporter: InMemoryExporter) -> None:
    with tracewright.run("run") as run:
        with tracewright.span("step-1") as step, tracewright.span("lookup", kind="tool"):
            pass
        with tracewright.span("step-2"):
            pass

    spans = {s["name"]: s for s in exporter.spans}
    assert {s["trace_id"] for s in spans.values()} == {run.trace_id}
    assert spans["step-1"]["parent_span_id"] == run.span_id
    assert spans["lookup"]["parent_span_id"] == step.span_id
    assert spans["step-2"]["parent_span_id"] == run.span_id
    assert tracewright.get_current_span() is None


def test_each_run_gets_a_new_trace(exporter: InMemoryExporter) -> None:
    with tracewright.run("a") as first:
        pass
    with tracewright.run("b") as second:
        pass
    assert first.trace_id != second.trace_id


def test_span_outside_run_starts_its_own_trace(exporter: InMemoryExporter) -> None:
    with tracewright.span("orphan") as orphan:
        pass
    assert orphan.parent_span_id is None
    assert HEX32.match(orphan.trace_id)


def test_exception_marks_span_error_and_propagates(exporter: InMemoryExporter) -> None:
    with pytest.raises(ValueError, match="boom"), tracewright.run("run"), tracewright.span("inner"):
        raise ValueError("boom")

    spans = {s["name"]: s for s in exporter.spans}
    for name in ("inner", "run"):
        assert spans[name]["status"] == "error"
        assert spans[name]["error"] == {"type": "ValueError", "message": "boom"}


def test_inputs_are_snapshotted_when_set(exporter: InMemoryExporter) -> None:
    messages = [{"role": "user", "content": "hi"}]
    with tracewright.span("llm", kind="llm", input=messages):
        messages.append({"role": "assistant", "content": "hello"})

    assert exporter.spans[0]["input"] == [{"role": "user", "content": "hi"}]


def test_mutations_after_end_are_ignored(exporter: InMemoryExporter) -> None:
    with tracewright.span("s") as s:
        s.set_attribute("k", 1)
    s.set_attribute("k", 2)
    s.set_output("late")
    s.end()

    (record,) = exporter.spans
    assert record["attributes"] == {"k": 1}
    assert record["output"] is None


def test_async_context_manager_and_task_propagation(exporter: InMemoryExporter) -> None:
    async def child(name: str, delay: float) -> str:
        async with tracewright.span(name) as span:
            await asyncio.sleep(delay)
            async with tracewright.span(f"{name}.inner"):
                await asyncio.sleep(0)
            return span.span_id

    async def main() -> tuple[str, list[str]]:
        async with tracewright.run("async-run") as run:
            ids = await asyncio.gather(child("a", 0.02), child("b", 0.0), child("c", 0.01))
            return run.span_id, list(ids)

    root_id, child_ids = asyncio.run(main())

    spans = {s["name"]: s for s in exporter.spans}
    for name, span_id in zip("abc", child_ids, strict=True):
        assert spans[name]["parent_span_id"] == root_id
        assert spans[f"{name}.inner"]["parent_span_id"] == span_id
    assert len({s["trace_id"] for s in exporter.spans}) == 1


def test_concurrent_runs_in_tasks_do_not_mix(exporter: InMemoryExporter) -> None:
    async def one_run(i: int) -> str:
        async with tracewright.run(f"run-{i}") as run:
            for step in range(3):
                async with tracewright.span(f"run-{i}.step-{step}"):
                    await asyncio.sleep(0.001 * ((i + step) % 3))
            return run.trace_id

    async def main() -> list[str]:
        return list(await asyncio.gather(*(one_run(i) for i in range(5))))

    trace_ids = asyncio.run(main())

    assert len(set(trace_ids)) == 5
    for i, trace_id in enumerate(trace_ids):
        steps = [s for s in exporter.spans if s["name"].startswith(f"run-{i}.")]
        assert len(steps) == 3
        assert {s["trace_id"] for s in steps} == {trace_id}


def test_name_is_clamped_to_contract_length(exporter: InMemoryExporter) -> None:
    with tracewright.span("x" * 300):
        pass
    assert len(exporter.spans[0]["name"]) == 256
