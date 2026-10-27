"""Command-line entry point: ``research-agent "question" --backend mock``."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import tracewright
from tracewright.testing import InMemoryExporter

from research_agent.agent import AgentResult, ResearchAgent
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
        "--scenario",
        choices=sorted(SCENARIOS),
        help=f"mock script (default {DEFAULT_SCENARIO}, or the replayed run's scenario)",
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

    replay = parser.add_argument_group(
        "replay",
        "Re-run a recorded run: steps before --from-step are served from the recording, "
        "later steps go live with the overrides. Reads the run with TRACEWRIGHT_API_KEY.",
    )
    replay.add_argument("--replay", metavar="TRACE_ID", help="trace id of the run to replay")
    replay.add_argument("--from-step", type=int, default=1, help="first step to run live")
    replay.add_argument("--override-model", metavar="MODEL", help="model for live LLM calls")
    replay.add_argument(
        "--override-system-append", metavar="TEXT", help="text appended to the system prompt"
    )
    replay.add_argument(
        "--replay-tools",
        choices=("recorded", "live"),
        default="recorded",
        help="from --from-step on, reuse recorded results of tool calls whose arguments are "
        "unchanged (recorded, the default) or always execute tools (live)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.list_scenarios:
        for scenario in SCENARIOS.values():
            print(f"{scenario.name:22} {scenario.description}\n{'':22} Q: {scenario.question}")
        return 0

    capture = InMemoryExporter() if args.print_spans else None
    tracewright.init(exporter=capture)
    try:
        return replay(args, capture) if args.replay else record(args, capture)
    finally:
        tracewright.shutdown(timeout=5)


def record(args: argparse.Namespace, capture: InMemoryExporter | None) -> int:
    scenario = args.scenario or DEFAULT_SCENARIO
    question = args.question
    if question is None:
        if args.backend != "mock":
            print("error: a question is required for non-mock backends", file=sys.stderr)
            return 2
        question = SCENARIOS[scenario].question
    print(f"Q: {question}\n", flush=True)
    return run_agent(build_agent(args, scenario), question, capture)


def replay(args: argparse.Namespace, capture: InMemoryExporter | None) -> int:
    """Re-run ``args.replay`` with the same question (and mock scenario) as the original."""
    overrides = {"model": args.override_model, "system_append": args.override_system_append}
    try:
        session = tracewright.replay(
            args.replay,
            from_step=args.from_step,
            overrides={k: v for k, v in overrides.items() if v is not None},
            tools=args.replay_tools,
        )
        with session:
            assert session.recording is not None
            root = session.recording.root or {}
            question = args.question or (root.get("input") or {}).get("question")
            if not question:
                print("error: the recorded run has no question; pass one", file=sys.stderr)
                return 2
            scenario = args.scenario or _recorded_scenario(root) or DEFAULT_SCENARIO
            agent = build_agent(args, scenario, extra_tags=["replay"])
            print(f"Replaying {args.replay} from step {args.from_step}\nQ: {question}\n")
            exit_code = run_agent(agent, question, capture)
    except tracewright.ReplayError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(
        f"\nreplay of {session.original_trace_id}: {session.served_calls} calls served from "
        f"the recording, {session.live_calls} live"
    )
    if session.divergence is not None:
        print(f"diverged from the recording at {session.divergence}")
    return exit_code


def _recorded_scenario(root: Mapping[str, Any]) -> str | None:
    for tag in (root.get("attributes") or {}).get("tracewright.tags") or []:
        name = str(tag).removeprefix("scenario:")
        if name != tag and name in SCENARIOS:
            return name
    return None


def build_agent(
    args: argparse.Namespace, scenario: str, extra_tags: Sequence[str] = ()
) -> ResearchAgent:
    backend = create_backend(
        args.backend, model=args.model, scenario=scenario, mock_latency=args.mock_latency
    )
    tags = [f"scenario:{scenario}"] if args.backend == "mock" else []
    return ResearchAgent(
        backend,
        Toolbox(notes_dir=args.notes_dir),
        max_steps=args.max_steps,
        tags=[*tags, *extra_tags],
    )


def run_agent(agent: ResearchAgent, question: str, capture: InMemoryExporter | None) -> int:
    exit_code = 0
    result: AgentResult | None = None
    try:
        result = agent.run(question)
    except Exception as exc:
        print(f"run failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = 1
    if result is not None:
        print(f"A: {result.answer}\n\ntrace {result.trace_id} ({result.steps} steps)")
    if capture is not None:
        print("\n" + format_span_tree(capture.spans))
    return exit_code


def format_span_tree(spans: list[dict[str, Any]]) -> str:
    children: dict[str | None, list[dict[str, Any]]] = {}
    for span in sorted(spans, key=lambda s: s["start_time"]):
        children.setdefault(span["parent_span_id"], []).append(span)

    lines: list[str] = []

    def walk(span: dict[str, Any], depth: int) -> None:
        duration_ms = (_parse(span["end_time"]) - _parse(span["start_time"])).total_seconds() * 1000
        status = "" if span["status"] == "ok" else f"  ERROR {span['error']['message']}"
        replayed = "  (replayed)" if span["attributes"].get("tracewright.replayed") else ""
        lines.append(
            f"{'  ' * depth}{span['kind']:6} {span['name']}  {duration_ms:.0f} ms{status}{replayed}"
        )
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
