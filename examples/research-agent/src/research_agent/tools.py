"""The agent's tools. Each tool call is recorded as a Tracewright ``tool`` span."""

from __future__ import annotations

import ast
import json
import operator
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tracewright

from research_agent.corpus import Corpus
from research_agent.transcript import ToolCall, ToolResult


class CalculatorError(ValueError):
    pass


_BINARY_OPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS: dict[type[ast.unaryop], Callable[[Any], Any]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_MAX_EXPONENT = 100
_MAX_EXPRESSION_LENGTH = 200


def evaluate(expression: str) -> int | float:
    """Evaluate plain arithmetic by walking the AST; anything else is rejected."""
    if len(expression) > _MAX_EXPRESSION_LENGTH:
        raise CalculatorError("expression is too long")
    try:
        tree = ast.parse(expression.strip(), mode="eval")
    except SyntaxError as exc:
        raise CalculatorError(f"invalid syntax in {expression!r}") from exc
    result = _eval_node(tree.body)
    if isinstance(result, float) and result.is_integer():
        return int(result)
    return round(result, 10) if isinstance(result, float) else result


def _eval_node(node: ast.expr) -> int | float:
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPS:
        left, right = _eval_node(node.left), _eval_node(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > _MAX_EXPONENT:
            raise CalculatorError("exponent is too large")
        try:
            return _BINARY_OPS[type(node.op)](left, right)  # type: ignore[no-any-return]
        except ZeroDivisionError as exc:
            raise CalculatorError("division by zero") from exc
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_eval_node(node.operand))  # type: ignore[no-any-return]
    raise CalculatorError(
        f"unsupported element {ast.unparse(node)!r}: only numbers and + - * / // % ** ( ) "
        "are allowed"
    )


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


def _object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


TOOL_SPECS = [
    ToolSpec(
        "search_corpus",
        "Keyword search over a library of short articles on the history of spaceflight. "
        "Returns the best-matching articles with a relevant excerpt.",
        _object_schema(
            {
                "query": {"type": "string", "description": "Keywords to search for."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 5, "default": 3},
            },
            ["query"],
        ),
    ),
    ToolSpec(
        "calculator",
        "Evaluate an arithmetic expression. Supports numbers, parentheses and "
        "+ - * / // % **. Units and words are not allowed.",
        _object_schema({"expression": {"type": "string"}}, ["expression"]),
    ),
    ToolSpec(
        "save_note",
        "Save a short research note for later reference.",
        _object_schema(
            {"title": {"type": "string"}, "content": {"type": "string"}}, ["title", "content"]
        ),
    ),
]


@dataclass(frozen=True)
class Note:
    title: str
    content: str


class Toolbox:
    def __init__(self, corpus: Corpus | None = None, notes_dir: Path | None = None) -> None:
        self._corpus = corpus or Corpus.bundled()
        self._notes_dir = notes_dir
        self.notes: list[Note] = []
        self._handlers: dict[str, Callable[..., Any]] = {
            "search_corpus": self.search_corpus,
            "calculator": self.calculator,
            "save_note": self.save_note,
        }

    @property
    def specs(self) -> list[ToolSpec]:
        return TOOL_SPECS

    @tracewright.trace(kind="tool")
    def search_corpus(self, query: str, limit: int = 3) -> list[dict[str, Any]]:
        hits = self._corpus.search(query, limit=max(1, min(limit, 5)))
        return [
            {"doc_id": h.doc_id, "title": h.title, "score": h.score, "excerpt": h.snippet}
            for h in hits
        ]

    @tracewright.trace(kind="tool")
    def calculator(self, expression: str) -> int | float:
        return evaluate(expression)

    @tracewright.trace(kind="tool")
    def save_note(self, title: str, content: str) -> str:
        note = Note(title.strip(), content.strip())
        if not note.title:
            raise ValueError("note title must not be empty")
        self.notes.append(note)
        if self._notes_dir is not None:
            self._notes_dir.mkdir(parents=True, exist_ok=True)
            slug = re.sub(r"[^a-z0-9]+", "-", note.title.lower()).strip("-") or "note"
            path = self._notes_dir / f"{slug}.md"
            path.write_text(f"# {note.title}\n\n{note.content}\n", encoding="utf-8")
            return f"saved note to {path}"
        return f"saved note {note.title!r} ({len(self.notes)} total)"

    def execute(self, call: ToolCall) -> ToolResult:
        """Run a tool call. Failures become error results the model can react to."""
        handler = self._handlers.get(call.name)
        try:
            if handler is None:
                with tracewright.span(call.name, kind="tool", input=call.arguments) as span:
                    span.set_attribute("gen_ai.tool.name", call.name)
                    raise LookupError(f"unknown tool {call.name!r}")
            output = handler(**call.arguments)
        except Exception as exc:
            return ToolResult(call.id, call.name, f"{type(exc).__name__}: {exc}", is_error=True)
        content = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        return ToolResult(call.id, call.name, content)
