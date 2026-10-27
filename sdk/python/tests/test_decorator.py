from __future__ import annotations

import asyncio
import inspect

import pytest

import tracewright
from tracewright.testing import InMemoryExporter


@tracewright.trace(kind="tool")
def add(a: int, b: int = 2) -> int:
    """Add two numbers."""
    return a + b


@tracewright.trace
def bare(x: str) -> str:
    return x.upper()


@tracewright.trace(name="fetch-doc", kind="tool")
async def fetch(doc_id: str, *, verbose: bool = False) -> dict[str, str]:
    await asyncio.sleep(0)
    return {"id": doc_id}


def test_decorator_preserves_metadata_and_signature() -> None:
    assert add.__name__ == "add"
    assert add.__doc__ == "Add two numbers."
    signature = inspect.signature(add)
    assert list(signature.parameters) == ["a", "b"]
    assert signature.parameters["b"].default == 2
    assert signature.return_annotation == "int"  # stringified by __future__.annotations
    assert inspect.iscoroutinefunction(fetch)


def test_sync_function_records_args_and_return_value(exporter: InMemoryExporter) -> None:
    assert add(1) == 3

    (span,) = exporter.spans
    assert span["name"] == "add"
    assert span["kind"] == "tool"
    assert span["input"] == {"a": 1, "b": 2}
    assert span["output"] == 3
    assert span["attributes"]["gen_ai.tool.name"] == "add"


def test_bare_decorator_defaults_to_custom_kind(exporter: InMemoryExporter) -> None:
    assert bare("hi") == "HI"
    assert exporter.spans[0]["kind"] == "custom"
    assert "gen_ai.tool.name" not in exporter.spans[0]["attributes"]


def test_async_function_is_traced(exporter: InMemoryExporter) -> None:
    async def main() -> dict[str, str]:
        with tracewright.run("r"):
            return await fetch("doc-1", verbose=True)

    assert asyncio.run(main()) == {"id": "doc-1"}
    spans = {s["name"]: s for s in exporter.spans}
    assert spans["fetch-doc"]["input"] == {"doc_id": "doc-1", "verbose": True}
    assert spans["fetch-doc"]["parent_span_id"] == spans["r"]["span_id"]


def test_exception_is_recorded_and_reraised(exporter: InMemoryExporter) -> None:
    @tracewright.trace(kind="tool")
    def divide(a: float, b: float) -> float:
        return a / b

    with pytest.raises(ZeroDivisionError):
        divide(1, 0)

    (span,) = exporter.spans
    assert span["status"] == "error"
    assert span["error"]["type"] == "ZeroDivisionError"
    assert span["output"] is None


def test_async_exception_is_recorded(exporter: InMemoryExporter) -> None:
    @tracewright.trace
    async def fail() -> None:
        raise RuntimeError("nope")

    with pytest.raises(RuntimeError):
        asyncio.run(fail())
    assert exporter.spans[0]["error"] == {"type": "RuntimeError", "message": "nope"}


def test_methods_exclude_self(exporter: InMemoryExporter) -> None:
    class Notes:
        @tracewright.trace(kind="tool")
        def save(self, text: str) -> int:
            return len(text)

    assert Notes().save("abc") == 3
    assert exporter.spans[0]["input"] == {"text": "abc"}


def test_capture_flags_suppress_payloads(exporter: InMemoryExporter) -> None:
    @tracewright.trace(capture_input=False, capture_output=False)
    def secret(token: str) -> str:
        return token[::-1]

    assert secret("abc") == "cba"
    assert exporter.spans[0]["input"] is None
    assert exporter.spans[0]["output"] is None


def test_non_serializable_values_are_reprd(exporter: InMemoryExporter) -> None:
    class Opaque:
        def __repr__(self) -> str:
            return "<Opaque>"

    @tracewright.trace
    def passthrough(value: object) -> object:
        return value

    obj = Opaque()
    assert passthrough(obj) is obj
    assert exporter.spans[0]["input"] == {"value": "<Opaque>"}
    assert exporter.spans[0]["output"] == "<Opaque>"
