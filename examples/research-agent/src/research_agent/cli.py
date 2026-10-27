"""Command-line entry point: ``research-agent "question" --backend mock``."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import tracewright
from tracewright.testing import InMemoryExporter

from research_agent.agent import ResearchAgent
from research_agent.backends import BACKENDS, DEFAULT_SCENARIO, SCENARIOS, create_backend
from research_agent.tools import Toolbox


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="research-agent",
        description="A tool-using research agent over a spaceflight-history corpus, "
        "traced with Tracewright.",
    )
    parser.add_argument("question", nargs="?", help="question to research (optional for mock)")
    parser.add_argument("--backend", choices=BACKENDS, default="mock")
    parser.add_argument("--model", help="model name (defaults depend on the backend)")
    parser.add_argument(
        "--scenario", choices=sorted(SCENARIOS), default=DEFAULT_SCENARIO, help="mock script"
    )
    parser.add_argument("--list-scenarios", action="store_true", help="show mock scenarios")
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument("--notes-dir", type=Path, help="also write saved notes to this folder")
    parser.add_argument(
        "--mock-latency",
        type=float,
        default=0.3,
        help="simulated seconds per mock LLM call, so traces have realistic timing",
    )
    parser.add_argument(
        "--print-spans",
        action="store_true",
        help="print the recorded span tree locally instead of sending it to Tracewright",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.list_scenarios:
        for scenario in SCENARIOS.values():
            print(f"{scenario.name:22} {scenario.description}\n{'':22} Q: {scenario.question}")
        return 0

    question = args.question
    if question is None:
        if args.backend != "mock":
            print("error: a question is required for non-mock backends", file=sys.stderr)
            return 2
        question = SCENARIOS[args.scenario].question

    capture = InMemoryExporter() if args.print_spans else None
    tracewright.init(exporter=capture)

    backend = create_backend(
        args.backend, model=args.model, scenario=args.scenario, mock_latency=args.mock_latency
    )
    tags = [f"scenario:{args.scenario}"] if args.backend == "mock" else []
    agent = ResearchAgent(
        backend, Toolbox(notes_dir=args.notes_dir), max_steps=args.max_steps, tags=tags
    )

    print(f"Q: {question}\n", flush=True)
    exit_code = 0
    try:
        result = agent.run(question)
    except Exception as exc:
        print(f"run failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = 1
    else:
        print(f"A: {result.answer}\n\ntrace {result.trace_id} ({result.steps} steps)")
    if capture is not None:
        print("\n" + format_span_tree(capture.spans))
    tracewright.shutdown(timeout=5)
    return exit_code


def format_span_tree(spans: list[dict[str, Any]]) -> str:
    children: dict[str | None, list[dict[str, Any]]] = {}
    for span in sorted(spans, key=lambda s: s["start_time"]):
        children.setdefault(span["parent_span_id"], []).append(span)

    lines: list[str] = []

    def walk(span: dict[str, Any], depth: int) -> None:
        duration_ms = (_parse(span["end_time"]) - _parse(span["start_time"])).total_seconds() * 1000
        status = "" if span["status"] == "ok" else f"  ERROR {span['error']['message']}"
        lines.append(f"{'  ' * depth}{span['kind']:6} {span['name']}  {duration_ms:.0f} ms{status}")
        for child in children.get(span["span_id"], []):
            walk(child, depth + 1)

    for root in children.get(None, []):
        walk(root, 0)
    return "\n".join(lines)


def _parse(timestamp: str) -> datetime:
    # Python <3.11 cannot parse nanoseconds or a trailing Z; microseconds are enough here.
    return datetime.fromisoformat(timestamp[:26] + "+00:00")


if __name__ == "__main__":
    raise SystemExit(main())
