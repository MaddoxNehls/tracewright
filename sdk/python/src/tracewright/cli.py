"""The ``tracewright`` command: ``tracewright eval run`` and ``tracewright eval compare``."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

import tracewright
from tracewright.eval.compare import compare, load_results, load_thresholds, render_markdown
from tracewright.eval.runner import GitInfo, run_suite
from tracewright.eval.suite import SuiteError, load_callable, load_suite

EXIT_REGRESSION = 1
EXIT_USAGE = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tracewright", description="Tracewright tools.")
    commands = parser.add_subparsers(dest="command", required=True)
    eval_parser = commands.add_parser("eval", help="run eval suites and compare results")
    eval_commands = eval_parser.add_subparsers(dest="eval_command", required=True)

    run = eval_commands.add_parser(
        "run",
        help="run a suite and write a results JSON file",
        description="Run every task of a suite through the agent's entrypoint, each call "
        "traced as a run (sent to Tracewright if TRACEWRIGHT_API_KEY is set), and score it.",
    )
    run.add_argument("suite", type=Path, help="suite YAML file")
    run.add_argument("--entrypoint", help="module:function(input) -> output (overrides the suite)")
    run.add_argument("--repeat", type=int, default=1, help="runs per task, to measure flakiness")
    run.add_argument("--task", action="append", default=[], help="only this task id (repeatable)")
    run.add_argument("-o", "--output", type=Path, help="results file (default: stdout)")
    run.add_argument("--git-sha", help="commit to record (default: detected)")
    run.add_argument("--git-branch", help="branch to record (default: detected)")

    cmp = eval_commands.add_parser(
        "compare",
        help="compare results against a baseline; exit 1 on regression",
        description="Write a markdown report comparing two results files. Exits 1 if the "
        "current results regressed past the thresholds.",
    )
    cmp.add_argument("--baseline", type=Path, required=True, help="baseline results JSON")
    cmp.add_argument("--current", type=Path, required=True, help="current results JSON")
    cmp.add_argument("--thresholds", type=Path, help="thresholds YAML")
    cmp.add_argument("-o", "--output", type=Path, help="report file (default: stdout)")
    cmp.add_argument(
        "--dashboard-url",
        default=os.environ.get("TRACEWRIGHT_DASHBOARD_URL"),
        help="link regressed tasks to the dashboard's run compare view "
        "(default: $TRACEWRIGHT_DASHBOARD_URL)",
    )
    cmp.add_argument(
        "--project",
        default=os.environ.get("TRACEWRIGHT_PROJECT"),
        help="project slug for dashboard links (default: $TRACEWRIGHT_PROJECT)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.eval_command == "run":
            return _run(args)
        return _compare(args)
    except SuiteError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE


def _run(args: argparse.Namespace) -> int:
    # Entrypoints and python scorers are usually modules of the project being evaluated.
    sys.path.insert(0, os.getcwd())
    suite = load_suite(args.suite).select(args.task)
    entrypoint = load_callable(args.entrypoint) if args.entrypoint else None
    if args.repeat < 1:
        raise SuiteError("--repeat must be at least 1")

    tracewright.init()
    try:
        results = run_suite(
            suite,
            entrypoint=entrypoint,
            repeat=args.repeat,
            git=GitInfo.detect(args.git_sha, args.git_branch),
            progress=lambda line: print(line, file=sys.stderr, flush=True),
        )
    finally:
        tracewright.shutdown(timeout=10)

    text = json.dumps(results, indent=2, ensure_ascii=False) + "\n"
    _write(args.output, text)
    agg = results["aggregate"]
    print(
        f"{agg['passed_tasks']}/{agg['tasks']} tasks passed"
        + (f", {agg['flaky_tasks']} flaky" if agg["flaky_tasks"] else ""),
        file=sys.stderr,
    )
    return 0


def _compare(args: argparse.Namespace) -> int:
    thresholds = load_thresholds(args.thresholds) if args.thresholds else None
    comparison = compare(load_results(args.baseline), load_results(args.current), thresholds)
    report = render_markdown(comparison, dashboard_url=args.dashboard_url, project=args.project)
    _write(args.output, report)
    return EXIT_REGRESSION if comparison.regressed else 0


def _write(path: Path | None, text: str) -> None:
    if path is None:
        # Reports contain non-ASCII (arrows); don't depend on the console's code page.
        sys.stdout.flush()
        sys.stdout.buffer.write(text.encode("utf-8"))
        sys.stdout.buffer.flush()
    else:
        path.write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    raise SystemExit(main())
