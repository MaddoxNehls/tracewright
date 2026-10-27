"""Compare a results file against a baseline and decide whether it regressed.

Thresholds (YAML, all optional):

.. code-block:: yaml

    max_newly_failing_tasks: 0     # tasks that passed in the baseline and now fail or flake
    metrics:                       # suite aggregates
      passed_tasks: {max_decrease: 0}
      cost_usd.total: {max_increase_pct: 20}
      latency_ms.p95: {max_increase_pct: 30, max_increase: 250}
    tasks:                         # per task (medians over repeats)
      steps: {max_increase: 0}

A metric regresses when it moves past *every* limit given for it, so an absolute limit
next to a percentage acts as a noise floor: ``latency_ms.p95`` above regresses only if it
grows by more than 30% and by more than 250 ms. A task over one of the ``tasks`` limits
is reported as regressed even if it still passes.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from tracewright.eval.results import RESULTS_VERSION
from tracewright.eval.suite import SuiteError

SUITE_METRICS = (
    "passed_tasks",
    "pass_rate",
    "cost_usd.total",
    "cost_usd.p50",
    "cost_usd.p95",
    "latency_ms.p50",
    "latency_ms.p95",
    "tokens.input",
    "tokens.output",
    "tokens.total",
    "steps.total",
)
TASK_METRICS = ("steps", "tokens", "input_tokens", "output_tokens", "cost_usd", "latency_ms")
# Always shown in the report, thresholded or not.
_HEADLINE_METRICS = ("passed_tasks", "cost_usd.total", "latency_ms.p95", "tokens.total")

_STATUS_RANK = {"fail": 0, "flaky": 1, "pass": 2}
REGRESSED_CHANGES = ("newly_failing", "newly_flaky", "regressed")
_CHANGE_ORDER = (*REGRESSED_CHANGES, "new", "removed", "fixed", "unchanged")


@dataclass(frozen=True)
class Limit:
    max_increase: float | None = None
    max_increase_pct: float | None = None
    max_decrease: float | None = None
    max_decrease_pct: float | None = None

    def exceeded(self, baseline: float | None, current: float | None) -> bool:
        if baseline is None or current is None or current == baseline:
            return False
        delta = current - baseline
        if delta > 0:
            limits = [(self.max_increase, delta), (self.max_increase_pct, _pct(delta, baseline))]
        else:
            limits = [(self.max_decrease, -delta), (self.max_decrease_pct, _pct(-delta, baseline))]
        active = [(limit, amount) for limit, amount in limits if limit is not None]
        return bool(active) and all(amount > limit for limit, amount in active)


def _pct(delta: float, baseline: float) -> float:
    if baseline == 0:
        return math.inf
    return delta / abs(baseline) * 100


@dataclass(frozen=True)
class Thresholds:
    max_newly_failing_tasks: int = 0
    metrics: Mapping[str, Limit] = field(default_factory=dict)
    tasks: Mapping[str, Limit] = field(default_factory=dict)


def load_thresholds(path: str | Path) -> Thresholds:
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise SuiteError(f"cannot read thresholds {path}: {exc}") from exc
    return parse_thresholds(data)


def parse_thresholds(data: Mapping[str, Any]) -> Thresholds:
    if not isinstance(data, Mapping):
        raise SuiteError("thresholds must be a mapping")
    unknown = set(data) - {"max_newly_failing_tasks", "metrics", "tasks"}
    if unknown:
        raise SuiteError(f"unknown thresholds key(s): {', '.join(sorted(unknown))}")
    newly_failing = data.get("max_newly_failing_tasks", 0)
    if not isinstance(newly_failing, int) or newly_failing < 0:
        raise SuiteError("max_newly_failing_tasks must be a non-negative integer")
    return Thresholds(
        newly_failing,
        _parse_limits(data.get("metrics") or {}, SUITE_METRICS, "metrics"),
        _parse_limits(data.get("tasks") or {}, TASK_METRICS, "tasks"),
    )


def _parse_limits(data: Any, allowed: Sequence[str], section: str) -> dict[str, Limit]:
    if not isinstance(data, Mapping):
        raise SuiteError(f"thresholds {section} must be a mapping")
    limits = {}
    for name, spec in data.items():
        if name not in allowed:
            raise SuiteError(f"unknown {section} metric {name!r}; choose from {', '.join(allowed)}")
        try:
            limits[name] = Limit(**{k: float(v) for k, v in dict(spec).items()})
        except (TypeError, ValueError) as exc:
            raise SuiteError(f"thresholds {section}.{name}: {exc}") from exc
    return limits


def load_results(path: str | Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SuiteError(f"cannot read results {path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != RESULTS_VERSION:
        raise SuiteError(f"{path} is not a tracewright eval results file (version 1)")
    return data


# --- comparison ----------------------------------------------------------------------------


@dataclass(frozen=True)
class MetricDelta:
    name: str
    baseline: float | None
    current: float | None
    limit: Limit | None
    regressed: bool


@dataclass(frozen=True)
class TaskDelta:
    id: str
    change: str  # one of _CHANGE_ORDER
    baseline: Mapping[str, Any] | None
    current: Mapping[str, Any] | None
    over_limit: Sequence[str] = ()

    @property
    def regressed(self) -> bool:
        return self.change in REGRESSED_CHANGES


@dataclass(frozen=True)
class Comparison:
    suite: str
    baseline: Mapping[str, Any]
    current: Mapping[str, Any]
    thresholds: Thresholds
    tasks: Sequence[TaskDelta]
    metrics: Sequence[MetricDelta]

    @property
    def newly_failing(self) -> int:
        return sum(t.change in ("newly_failing", "newly_flaky") for t in self.tasks)

    @property
    def regressed(self) -> bool:
        return (
            self.newly_failing > self.thresholds.max_newly_failing_tasks
            or any(t.change == "regressed" for t in self.tasks)
            or any(m.regressed for m in self.metrics)
        )


def compare(
    baseline: Mapping[str, Any], current: Mapping[str, Any], thresholds: Thresholds | None = None
) -> Comparison:
    thresholds = thresholds or Thresholds()
    base_tasks = {t["id"]: t for t in baseline["tasks"]}
    cur_tasks = {t["id"]: t for t in current["tasks"]}

    tasks = []
    for task_id in [*cur_tasks, *(t for t in base_tasks if t not in cur_tasks)]:
        base, cur = base_tasks.get(task_id), cur_tasks.get(task_id)
        over_limit = []
        if base and cur:
            over_limit = [
                name
                for name, limit in thresholds.tasks.items()
                if limit.exceeded(base["metrics"].get(name), cur["metrics"].get(name))
            ]
        tasks.append(TaskDelta(task_id, _change(base, cur, over_limit), base, cur, over_limit))
    tasks.sort(key=lambda t: _CHANGE_ORDER.index(t.change))

    names = [*_HEADLINE_METRICS, *(m for m in thresholds.metrics if m not in _HEADLINE_METRICS)]
    metrics = []
    for name in names:
        before, after = _lookup(baseline["aggregate"], name), _lookup(current["aggregate"], name)
        limit = thresholds.metrics.get(name)
        metrics.append(
            MetricDelta(name, before, after, limit, bool(limit and limit.exceeded(before, after)))
        )
    return Comparison(str(current.get("suite")), baseline, current, thresholds, tasks, metrics)


def _change(
    base: Mapping[str, Any] | None, cur: Mapping[str, Any] | None, over_limit: Sequence[str]
) -> str:
    if base is None:
        return "new"
    if cur is None:
        return "removed"
    before, after = _STATUS_RANK[base["status"]], _STATUS_RANK[cur["status"]]
    if after < before:
        return "newly_failing" if cur["status"] == "fail" else "newly_flaky"
    if after > before:
        return "fixed"
    return "regressed" if over_limit else "unchanged"


def _lookup(aggregate: Mapping[str, Any], path: str) -> float | None:
    value: Any = aggregate
    for key in path.split("."):
        value = value.get(key) if isinstance(value, Mapping) else None
    return value if isinstance(value, (int, float)) else None


# --- markdown ------------------------------------------------------------------------------

_LABELS = {
    "passed_tasks": "passed tasks",
    "pass_rate": "pass rate",
    "steps": "steps",
    "tokens": "tokens",
    "input_tokens": "input tokens",
    "output_tokens": "output tokens",
    "cost_usd": "cost",
    "latency_ms": "latency",
}


def _label(name: str) -> str:
    base, _, stat = name.partition(".")
    label = _LABELS.get(base, base)
    return f"{label} ({stat})" if stat else label


def _formatter(name: str) -> Callable[[float], str]:
    base = name.partition(".")[0]
    if base == "cost_usd":
        return lambda v: f"${v:.5f}"
    if base == "latency_ms":
        return lambda v: f"{v:,.0f} ms"
    if base == "pass_rate":
        return lambda v: f"{v:.0%}"
    return lambda v: f"{v:,.0f}" if float(v).is_integer() else f"{v:,.1f}"


def _delta(name: str, before: float | None, after: float | None) -> str:
    if before is None or after is None:
        return "n/a"
    fmt = _formatter(name)
    if before == after:
        return "no change"
    sign = "+" if after > before else "-"
    text = sign + fmt(abs(after - before))
    if before != 0 and name.partition(".")[0] not in ("passed_tasks", "steps", "pass_rate"):
        text += f" ({(after - before) / abs(before):+.1%})"
    return text


def _metric_cell(name: str, before: float | None, after: float | None, flagged: bool) -> str:
    fmt = _formatter(name)
    if before is None and after is None:
        return "n/a"
    if before is None or after is None or before == after:
        value = after if after is not None else before
        return fmt(value) if value is not None else "n/a"
    cell = f"{fmt(before)} → {fmt(after)}"
    return f"**{cell}**" if flagged else cell


_CHANGE_TEXT = {
    "newly_failing": "**newly failing**",
    "newly_flaky": "**newly flaky**",
    "regressed": "**regressed**",
    "new": "new",
    "removed": "removed",
    "fixed": "fixed",
    "unchanged": "",
}


def render_markdown(
    comparison: Comparison, *, dashboard_url: str | None = None, project: str | None = None
) -> str:
    """A PR-comment-sized report: verdict, task table (regressions first), suite metrics,
    and the failing checks with links to compare each regressed task's runs."""
    c = comparison
    lines = [f"## Tracewright eval: `{c.suite}`", "", _verdict(c), "", _provenance(c), ""]

    changed = [t for t in c.tasks if t.change != "unchanged"]
    unchanged = [t for t in c.tasks if t.change == "unchanged"]
    lines += ["### Tasks", ""]
    if changed:
        lines += _task_table(changed, dashboard_url, project)
    else:
        lines.append("No task changed status or crossed a per-task threshold.")
    if unchanged:
        lines += [
            "",
            f"<details><summary>{_plural(len(unchanged), 'unchanged task')}</summary>",
            "",
            *_task_table(unchanged, dashboard_url, project),
            "",
            "</details>",
        ]

    lines += ["", "### Suite metrics", "", "| metric | baseline | current | change | threshold |"]
    lines.append("|---|---|---|---|---|")
    for m in c.metrics:
        fmt = _formatter(m.name)
        threshold = _describe_limit(m.name, m.limit) if m.limit else ""
        if m.regressed:
            threshold = f"**exceeded** ({threshold})"
        lines.append(
            f"| {_label(m.name)} | {fmt(m.baseline) if m.baseline is not None else 'n/a'} "
            f"| {fmt(m.current) if m.current is not None else 'n/a'} "
            f"| {_delta(m.name, m.baseline, m.current)} | {threshold} |"
        )

    failures = _failures(c)
    if failures:
        lines += ["", "### Failing checks", "", *failures]
    return "\n".join(lines) + "\n"


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _describe_limit(name: str, limit: Limit) -> str:
    """E.g. "max +500 ms and +50%", or "no decrease" for a zero limit."""
    fmt = _formatter(name)
    parts = []
    for direction, sign, absolute, pct in (
        ("increase", "+", limit.max_increase, limit.max_increase_pct),
        ("decrease", "-", limit.max_decrease, limit.max_decrease_pct),
    ):
        if absolute == 0 and pct is None:
            parts.append(f"no {direction}")
            continue
        bounds = [sign + fmt(absolute)] if absolute is not None else []
        bounds += [f"{sign}{pct:g}%"] if pct is not None else []
        if bounds:
            parts.append("max " + " and ".join(bounds))
    return "; ".join(parts)


def _verdict(c: Comparison) -> str:
    reasons = []
    if c.newly_failing:
        allowed = c.thresholds.max_newly_failing_tasks
        reasons.append(f"{_plural(c.newly_failing, 'task')} newly failing (allowed: {allowed})")
    over_task = sum(t.change == "regressed" for t in c.tasks)
    if over_task:
        reasons.append(f"{_plural(over_task, 'task')} over a per-task threshold")
    over_suite = [_label(m.name) for m in c.metrics if m.regressed]
    if over_suite:
        reasons.append(f"suite {', '.join(over_suite)} over threshold")
    agg = c.current["aggregate"]
    summary = f"{agg['passed_tasks']}/{agg['tasks']} tasks pass"
    if c.regressed:
        return f"**Regression.** {'; '.join(reasons)}. {summary}."
    note = f" ({'; '.join(reasons)}, within thresholds)" if reasons else ""
    return f"**No regression.** {summary}{note}."


def _provenance(c: Comparison) -> str:
    def describe(results: Mapping[str, Any]) -> str:
        git = results.get("git") or {}
        sha = (git.get("sha") or "unknown")[:12]
        branch = f" on `{git['branch']}`" if git.get("branch") else ""
        return f"`{sha}`{branch}"

    repeat = c.current.get("repeat", 1)
    runs = f"{repeat} runs per task" if repeat > 1 else "1 run per task"
    return f"Baseline {describe(c.baseline)} vs current {describe(c.current)}; {runs}."


def _task_table(
    tasks: Sequence[TaskDelta], dashboard_url: str | None, project: str | None
) -> list[str]:
    rows = [
        "| task | change | baseline | current | steps | tokens | cost | latency | runs |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for t in tasks:
        base, cur = t.baseline or {}, t.current or {}
        cells = [
            _metric_cell(
                name,
                (base.get("metrics") or {}).get(name),
                (cur.get("metrics") or {}).get(name),
                name in t.over_limit,
            )
            for name in ("steps", "tokens", "cost_usd", "latency_ms")
        ]
        rows.append(
            f"| `{t.id}` | {_CHANGE_TEXT[t.change]} | {_status(base)} | {_status(cur)} "
            f"| {' | '.join(cells)} | {_runs_link(t, dashboard_url, project)} |"
        )
    return rows


def _status(task: Mapping[str, Any]) -> str:
    if not task:
        return "-"
    status = str(task["status"])
    return f"{status} ({task['passes']}/{task['repeat']})" if task["repeat"] > 1 else status


def _first_trace(task: Mapping[str, Any]) -> str | None:
    runs = task.get("runs") or []
    failing = [r for r in runs if not r["passed"]]
    return str((failing or runs)[0]["trace_id"]) if runs else None


def _runs_link(t: TaskDelta, dashboard_url: str | None, project: str | None) -> str:
    """For a regressed task, link the dashboard's side-by-side diff of the two runs."""
    if not (t.regressed and dashboard_url and project and t.baseline and t.current):
        return ""
    before, after = _first_trace(t.baseline), _first_trace(t.current)
    if not (before and after):
        return ""
    return f"[compare]({dashboard_url.rstrip('/')}/p/{project}/compare?a={before}&b={after})"


def _failures(c: Comparison) -> list[str]:
    lines = []
    for t in c.tasks:
        if not t.current:
            continue
        for i, run in enumerate(t.current["runs"], start=1):
            if run["passed"]:
                continue
            problems = [f"`{s['scorer']}` failed" + (f": {s['detail']}" if s["detail"] else "")
                        for s in run["scores"] if s["passed"] is False]  # fmt: skip
            if run["error"]:
                problems.insert(0, f"raised {run['error']['type']}: {run['error']['message']}")
            where = f" run {i}" if len(t.current["runs"]) > 1 else ""
            lines.append(f"- `{t.id}`{where} (trace `{run['trace_id']}`): {'; '.join(problems)}")
    return lines
