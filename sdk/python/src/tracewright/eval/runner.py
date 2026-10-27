"""Run a suite: call the agent's entrypoint once per task (and repeat), each call a traced
run, then score and measure it from the spans it produced."""

from __future__ import annotations

import asyncio
import datetime as dt
import inspect
import logging
import os
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import tracewright
from tracewright._replay import step_attribute
from tracewright._serialize import to_jsonable
from tracewright._tracer import TraceCapture
from tracewright.eval import scorers
from tracewright.eval.pricing import PriceTable
from tracewright.eval.results import (
    RESULTS_VERSION,
    RunOutcome,
    aggregate,
    measure,
    task_summary,
)
from tracewright.eval.suite import Suite, Task, load_callable

logger = logging.getLogger("tracewright")


@dataclass(frozen=True)
class GitInfo:
    sha: str | None
    branch: str | None

    @classmethod
    def detect(cls, sha: str | None = None, branch: str | None = None) -> GitInfo:
        """Explicit values win, then CI variables, then the local checkout."""
        sha = sha or _git("rev-parse", "HEAD") or os.environ.get("GITHUB_SHA")
        branch = (
            branch
            or os.environ.get("GITHUB_HEAD_REF")  # the PR's source branch
            or os.environ.get("GITHUB_REF_NAME")
            or _git("rev-parse", "--abbrev-ref", "HEAD")
        )
        return cls(sha, branch)


def _git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args], capture_output=True, text=True, check=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def run_suite(
    suite: Suite,
    *,
    entrypoint: Callable[[Any], Any] | None = None,
    repeat: int = 1,
    git: GitInfo | None = None,
    prices: PriceTable | None = None,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run every task ``repeat`` times and return the results document (JSON-ready)."""
    if repeat < 1:
        raise ValueError("repeat must be at least 1")
    if entrypoint is None:
        if suite.entrypoint is None:
            raise ValueError("the suite has no entrypoint; pass one")
        entrypoint = load_callable(suite.entrypoint)
    git = git or GitInfo.detect()
    prices = (prices or PriceTable.default()).with_overrides(suite.pricing)
    # Build every scorer before running anything, so a typo fails fast.
    task_scorers = {t.id: [scorers.build(spec) for spec in t.scorers] for t in suite.tasks}

    summaries = []
    for task in suite.tasks:
        runs = []
        for attempt in range(repeat):
            run = _run_once(suite, task, entrypoint, attempt, git, prices)
            run.scores = [score(run) for score in task_scorers[task.id]]
            runs.append(run)
            if progress:
                status = "pass" if run.passed else "FAIL"
                progress(f"{status} {task.id} ({run.steps} steps, {run.latency_ms:.0f} ms)")
        summaries.append(task_summary(task.id, task.input, runs))

    return {
        "version": RESULTS_VERSION,
        "suite": suite.id,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "git": {"sha": git.sha, "branch": git.branch},
        "repeat": repeat,
        "tasks": summaries,
        "aggregate": aggregate(summaries),
    }


def _run_once(
    suite: Suite,
    task: Task,
    entrypoint: Callable[[Any], Any],
    attempt: int,
    git: GitInfo,
    prices: PriceTable,
) -> RunOutcome:
    tags = [f"eval:{suite.id}", f"eval-task:{task.id}"]
    tags += [f"git:{git.sha[:12]}"] if git.sha else []
    tags += [f"branch:{git.branch}"] if git.branch else []
    attributes = {
        "tracewright.eval.suite": suite.id,
        "tracewright.eval.task": task.id,
        "tracewright.eval.attempt": attempt + 1,
        "vcs.ref.head.revision": git.sha,
        "vcs.ref.head.name": git.branch,
    }

    capture: TraceCapture | None = None
    output: Any = None
    error: dict[str, str] | None = None
    started = time.perf_counter()
    try:
        with tracewright.run(
            f"eval {task.id}",
            tags=tags,
            input=task.input,
            attributes={k: v for k, v in attributes.items() if v is not None},
        ) as root:
            capture = TraceCapture(root.trace_id)
            output = to_jsonable(_call(entrypoint, task.input))
            root.set_output(output)
    except Exception as exc:  # the run failed; record it and move on to the next task
        error = {"type": type(exc).__name__, "message": str(exc)}
    latency_ms = (time.perf_counter() - started) * 1000

    assert capture is not None  # tracewright.run itself never raises on entry
    spans = [span.to_dict() for span in capture.stop()]
    return RunOutcome(
        input=task.input,
        output=output,
        trace_id=capture.trace_id,
        error=error,
        latency_ms=round(latency_ms, 3),
        **measure(spans, prices, step_attribute(suite.step_attribute)),
    )


def _call(entrypoint: Callable[[Any], Any], task_input: Any) -> Any:
    result = entrypoint(task_input)
    if inspect.isawaitable(result):
        return asyncio.run(_await(result))
    return result


async def _await(awaitable: Any) -> Any:
    return await awaitable
