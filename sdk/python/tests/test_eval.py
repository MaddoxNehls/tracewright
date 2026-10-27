"""tracewright eval: scorers, measurement, the runner, compare, and the CLI."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

import tracewright
from tracewright.cli import main
from tracewright.eval import (
    GitInfo,
    Limit,
    PriceTable,
    RunOutcome,
    Score,
    SuiteError,
    Thresholds,
    compare,
    measure,
    parse_suite,
    parse_thresholds,
    percentile,
    render_markdown,
    run_suite,
)
from tracewright.eval import scorers as scorer_lib
from tracewright.eval.results import aggregate, task_summary
from tracewright.testing import InMemoryExporter

REPO_ROOT = Path(__file__).resolve().parents[3]
GIT = GitInfo("0123456789abcdef0123", "feature/x")


def outcome(**fields: Any) -> RunOutcome:
    defaults: dict[str, Any] = {
        "input": None,
        "output": "",
        "trace_id": "t" * 32,
        "error": None,
        "latency_ms": 10.0,
    }
    return RunOutcome(**{**defaults, **fields})


def score(spec: Any, run: RunOutcome) -> Score:
    return scorer_lib.build(spec)(run)


# --- scorers ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("spec", "output", "passed"),
    [
        ({"contains": "23 days"}, "Shepard flew 23 days later.", True),
        ({"contains": "23 days"}, "Shepard flew later.", False),
        ({"contains": '"days": 23'}, {"days": 23}, True),  # non-strings are matched as JSON
        ({"regex": r"\b5\.6%"}, "about 5.6% of samples", True),
        ({"regex": r"^\d+$"}, "12 years", False),
        ({"equals": {"a": [1, 2]}}, {"a": [1, 2]}, True),
        ({"equals": "x"}, "x ", False),
    ],
)
def test_output_scorers(spec: Any, output: Any, passed: bool) -> None:
    assert score(spec, outcome(output=output)).passed is passed


def test_no_error_counts_recovered_span_errors_unless_scoped_to_the_run() -> None:
    recovered = outcome(span_errors=[{"span": "calculator", "type": "E", "message": "bad"}])
    strict = score("no_error", recovered)
    assert strict.passed is False
    assert strict.detail == "calculator: E: bad"
    assert score({"no_error": "run"}, recovered).passed is True

    crashed = outcome(error={"type": "Boom", "message": "x"})
    assert score({"no_error": "run"}, crashed).passed is False
    assert crashed.passed is False  # a run that raised fails even with no scorers


def test_budget_scorers() -> None:
    run = outcome(steps=5, cost_usd=0.02)
    assert score({"max_steps": 5}, run).passed is True
    assert score({"max_steps": 4}, run) == Score("max_steps: 4", False, "5 steps")
    assert score({"max_cost_usd": 0.05}, run).passed is True
    assert score({"max_cost_usd": 0.01}, run).passed is False
    unknown = score({"max_cost_usd": 1}, outcome(cost_usd=None))
    assert (unknown.passed, unknown.detail) == (False, "cost unknown: no priced LLM calls")


def checks_answer(run: RunOutcome) -> Any:
    if run.output == "raise":
        raise RuntimeError("bug in scorer")
    if run.output == "tuple":
        return False, "explained"
    return run.output == "ok"


def test_python_scorer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.syspath_prepend(str(Path(__file__).parent))
    spec = {"python": "test_eval:checks_answer"}
    assert score(spec, outcome(output="ok")).passed is True
    assert score(spec, outcome(output="tuple")) == Score(
        'python: "test_eval:checks_answer"', False, "explained"
    )
    raised = score(spec, outcome(output="raise"))
    assert raised.passed is False
    assert "RuntimeError: bug in scorer" in raised.detail


def test_llm_judge_is_a_skipped_stub_unless_a_judge_is_given() -> None:
    spec = {"llm_judge": {"criteria": "cites sources"}}
    skipped = score(spec, outcome())
    assert skipped.passed is None
    run = outcome(scores=[skipped])
    assert run.passed is True  # skipped scorers don't fail a run

    class Strict:
        def judge(self, *, criteria: str, input: Any, output: Any) -> tuple[bool, str]:
            return False, f"no: {criteria}"

    judged = scorer_lib.build(spec, judge=Strict())(outcome())
    assert (judged.passed, judged.detail) == (False, "no: cites sources")


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ("nope", "unknown scorer"),
        ({"contains": 3}, "contains got 3"),
        ({"regex": "("}, "regex"),
        ({"max_steps": "five"}, "max_steps"),
        ({"no_error": "sometimes"}, "no_error"),
        ({"python": "no_colon"}, "module:function"),
        ({"python": "tracewright:missing"}, "no attribute"),
        ({"contains": "a", "regex": "b"}, "single-key"),
    ],
)
def test_invalid_scorers_fail_fast(spec: Any, message: str) -> None:
    with pytest.raises(SuiteError, match=message):
        scorer_lib.build(spec)


# --- measurement and aggregation ----------------------------------------------------------


def wire_span(name: str, kind: str = "custom", **fields: Any) -> dict[str, Any]:
    return {"name": name, "kind": kind, "status": "ok", "attributes": {}, **fields}


def test_measure_counts_steps_calls_tokens_cost_and_errors() -> None:
    prices = PriceTable.parse({"m-1": {"input": 3.0, "output": 15.0}})
    llm_attrs = {
        "gen_ai.request.model": "m-1",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 100,
    }
    spans = [
        wire_span("agent", "agent", status="error", error={"type": "Boom", "message": "x"}),
        wire_span("step-1", attributes={"agent.step": 1}),
        wire_span("step-2", attributes={"agent.step": 2}),
        wire_span("chat", "llm", attributes=llm_attrs),
        wire_span("chat", "llm", attributes={**llm_attrs, "tracewright.cost_usd": 0}),
        wire_span("chat", "llm", attributes={**llm_attrs, "gen_ai.request.model": "unpriced"}),
        wire_span("calc", "tool", status="error", error={"type": "CalcError", "message": "no"}),
    ]

    measured = measure(spans, prices, tracewright.step_attribute())

    assert measured == {
        "steps": 2,
        "llm_calls": 3,
        "tool_calls": 1,
        "input_tokens": 3000,
        "output_tokens": 300,
        "cost_usd": 0.0045,  # 0.0045 priced + 0 explicit; the unpriced call is skipped
        "span_errors": [{"span": "calc", "type": "CalcError", "message": "no"}],
    }
    assert measure([], prices, tracewright.step_attribute())["cost_usd"] is None


def test_percentile_interpolates() -> None:
    assert percentile([], 50) is None
    assert percentile([7], 95) == 7
    assert percentile([1, 2, 3, 4], 50) == 2.5
    assert percentile([10, 20, 30, 40, 50], 95) == pytest.approx(48)


def test_flaky_tasks_and_aggregates() -> None:
    def runs(*passes: bool) -> list[RunOutcome]:
        return [
            outcome(scores=[Score("s", p)], latency_ms=10.0 * (i + 1), cost_usd=0.01, steps=2)
            for i, p in enumerate(passes)
        ]

    tasks = [
        task_summary("always", None, runs(True, True, True)),
        task_summary("sometimes", None, runs(True, False, True)),
        task_summary("never", None, runs(False, False, False)),
    ]
    assert [t["status"] for t in tasks] == ["pass", "flaky", "fail"]
    assert tasks[1]["passes"] == 2
    assert tasks[0]["metrics"]["latency_ms"] == 20.0  # median over the repeats

    agg = aggregate(tasks)
    assert (agg["passed_tasks"], agg["flaky_tasks"], agg["failed_tasks"]) == (1, 1, 1)
    assert agg["pass_rate"] == pytest.approx(1 / 3)
    assert (agg["runs"], agg["passed_runs"]) == (9, 5)
    assert agg["cost_usd"]["total"] == pytest.approx(0.09)
    assert agg["latency_ms"] == {"p50": 20.0, "p95": 30.0}
    assert agg["steps"]["total"] == 18


# --- pricing -------------------------------------------------------------------------------


def test_bundled_prices_match_the_ingest_service() -> None:
    ingest = REPO_ROOT / "ingest" / "internal" / "pricing" / "pricing.json"
    if not ingest.exists():
        pytest.skip("not running inside the tracewright repo")
    bundled = Path(tracewright.__file__).parent / "eval" / "pricing.json"
    assert json.loads(bundled.read_text("utf-8")) == json.loads(ingest.read_text("utf-8"))


def test_price_table() -> None:
    prices = PriceTable.default()
    assert prices.cost("claude-opus-5-5", 12_000, 800) == 0.064  # same as ingest's e2e test
    assert prices.cost("claude-opus-5-5-20261001", 12_000, 800) == 0.064  # dated snapshot
    assert prices.cost("claude-haiku-5-5", 200_000, 0) == 0.1  # long-context tier
    assert prices.cost("unknown", 1, 1) is None
    overridden = prices.with_overrides({"mock-1": {"input": 1, "output": 2}})
    assert overridden.cost("mock-1", 1_000_000, 1_000_000) == 3.0


# --- the runner ----------------------------------------------------------------------------


def agent(task: Mapping[str, Any]) -> str:
    """A small traced agent: opens its own run, like a real one would."""
    with tracewright.run("my-agent", tags=["agent-tag"]):
        for step in range(1, task["steps"] + 1):
            with (
                tracewright.span(f"step-{step}", attributes={"agent.step": step}),
                tracewright.span(
                    "chat m-1",
                    kind="llm",
                    attributes={
                        "gen_ai.request.model": "m-1",
                        "gen_ai.usage.input_tokens": 100,
                        "gen_ai.usage.output_tokens": 10,
                    },
                ),
            ):
                pass
        if task.get("fail"):
            raise ValueError("agent gave up")
        return f"answer after {task['steps']} steps"


SUITE = {
    "id": "unit",
    "pricing": {"m-1": {"input": 10.0, "output": 50.0}},
    "tasks": [
        {"id": "two", "input": {"steps": 2}, "scorers": [{"contains": "2 steps"}, "no_error"]},
        {"id": "boom", "input": {"steps": 1, "fail": True}, "scorers": ["no_error"]},
    ],
}


@pytest.fixture
def exporter() -> Iterator[InMemoryExporter]:
    memory = InMemoryExporter()
    tracewright.init(exporter=memory)
    yield memory
    tracewright.shutdown()


def test_run_suite_traces_tags_scores_and_measures(exporter: InMemoryExporter) -> None:
    results = run_suite(parse_suite(SUITE), entrypoint=agent, git=GIT)

    two, boom = results["tasks"]
    assert two["status"] == "pass"
    (run,) = two["runs"]
    assert run["output"] == "answer after 2 steps"
    assert (run["steps"], run["llm_calls"], run["tokens"]) == (2, 2, 220)
    assert run["cost_usd"] == pytest.approx(2 * (100 * 10 + 10 * 50) / 1e6)
    assert [s["passed"] for s in run["scores"]] == [True, True]

    # The agent's own run joined the eval's trace, and every tag landed on the root.
    roots = exporter.roots()
    root = next(r for r in roots if r["trace_id"] == run["trace_id"])
    assert root["name"] == "eval two"
    assert root["attributes"]["tracewright.tags"] == [
        "eval:unit",
        "eval-task:two",
        "git:0123456789ab",
        "branch:feature/x",
        "agent-tag",
    ]
    assert root["attributes"]["tracewright.eval.task"] == "two"
    assert root["output"] == "answer after 2 steps"
    agent_span = exporter.by_name("my-agent")[0]
    assert (agent_span["trace_id"], agent_span["parent_span_id"]) == (
        root["trace_id"],
        root["span_id"],
    )

    # A task whose agent raises fails, and the suite carries on.
    assert boom["status"] == "fail"
    assert boom["runs"][0]["error"] == {"type": "ValueError", "message": "agent gave up"}
    assert results["git"] == {"sha": GIT.sha, "branch": GIT.branch}
    assert results["aggregate"]["passed_tasks"] == 1


def test_run_suite_measures_runs_without_any_exporter() -> None:
    tracewright.init()  # no API key: spans go nowhere, but the eval still sees them
    results = run_suite(parse_suite(SUITE), entrypoint=agent, git=GIT)
    assert results["tasks"][0]["runs"][0]["steps"] == 2


def test_repeat_exposes_flaky_tasks(exporter: InMemoryExporter) -> None:
    calls = iter(range(100))

    def sometimes(task: Any) -> str:
        return "ok" if next(calls) % 2 == 0 else "nope"

    suite = parse_suite({"id": "s", "tasks": [{"id": "t", "scorers": [{"equals": "ok"}]}]})
    results = run_suite(suite, entrypoint=sometimes, repeat=4, git=GIT)

    (task,) = results["tasks"]
    assert (task["status"], task["passes"], task["repeat"]) == ("flaky", 2, 4)
    assert len({r["trace_id"] for r in task["runs"]}) == 4
    assert results["aggregate"]["flaky_tasks"] == 1


def test_async_entrypoints_are_awaited(exporter: InMemoryExporter) -> None:
    async def answer(task: Any) -> str:
        await asyncio.sleep(0)
        return "async ok"

    suite = parse_suite({"id": "s", "tasks": [{"id": "t", "scorers": [{"equals": "async ok"}]}]})
    assert run_suite(suite, entrypoint=answer, git=GIT)["tasks"][0]["status"] == "pass"


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"tasks": [{"id": "a"}]}, "id"),
        ({"id": "s", "tasks": []}, "non-empty"),
        ({"id": "s", "tasks": [{"id": "a"}, {"id": "a"}]}, "duplicate"),
        ({"id": "s", "tasks": [{"id": "has space"}]}, "tasks\\[0\\].id"),
        ({"id": "s", "tasks": [{"id": "a", "scorers": "no_error"}]}, "must be a list"),
    ],
)
def test_invalid_suites(data: Any, message: str) -> None:
    with pytest.raises(SuiteError, match=message):
        parse_suite(data)


def test_select_tasks() -> None:
    suite = parse_suite(SUITE)
    assert [t.id for t in suite.select(["boom"]).tasks] == ["boom"]
    with pytest.raises(SuiteError, match="unknown task"):
        suite.select(["nope"])


# --- compare -------------------------------------------------------------------------------


def results(
    tasks: Mapping[str, tuple[bool, ...]],
    *,
    steps: int = 3,
    cost: float | None = 0.01,
    sha: str = "b",
) -> dict[str, Any]:
    """A results document: each task maps to the pass/fail of its runs."""
    summaries = [
        task_summary(
            task_id,
            None,
            [
                outcome(
                    scores=[Score("max_steps: 3", passed, "" if passed else f"{steps} steps")],
                    steps=steps,
                    cost_usd=cost,
                    trace_id=f"{task_id}-{sha}-{i}",
                )
                for i, passed in enumerate(passes)
            ],
        )
        for task_id, passes in tasks.items()
    ]
    return {
        "version": 1,
        "suite": "s",
        "git": {"sha": sha * 12, "branch": "main"},
        "repeat": max(len(p) for p in tasks.values()),
        "tasks": summaries,
        "aggregate": aggregate(summaries),
    }


def test_identical_results_do_not_regress() -> None:
    baseline = results({"a": (True,), "b": (True,)})
    comparison = compare(baseline, results({"a": (True,), "b": (True,)}))

    assert not comparison.regressed
    assert {t.change for t in comparison.tasks} == {"unchanged"}
    report = render_markdown(comparison)
    assert "**No regression.** 2/2 tasks pass." in report
    assert "<details><summary>2 unchanged tasks</summary>" in report


def test_newly_failing_tasks_regress_and_come_first() -> None:
    baseline = results({"a": (True,), "b": (True,), "c": (False,)})
    current = results({"a": (True,), "c": (True,), "b": (False,)}, sha="c")

    comparison = compare(baseline, current)

    assert [(t.id, t.change) for t in comparison.tasks] == [
        ("b", "newly_failing"),
        ("c", "fixed"),
        ("a", "unchanged"),
    ]
    assert comparison.regressed
    report = render_markdown(comparison, dashboard_url="https://dash.example/", project="demo")
    assert report.index("`b`") < report.index("`c`")
    assert "**Regression.** 1 task newly failing (allowed: 0)" in report
    assert "[compare](https://dash.example/p/demo/compare?a=b-b-0&b=b-c-0)" in report
    assert "- `b` (trace `b-c-0`): `max_steps: 3` failed: 3 steps" in report
    # Only regressed tasks get links.
    assert "a=c-b-0" not in report


def test_max_newly_failing_tasks_tolerates_some_failures() -> None:
    baseline = results({"a": (True,), "b": (True,)})
    current = results({"a": (True,), "b": (False,)})
    assert not compare(baseline, current, Thresholds(max_newly_failing_tasks=1)).regressed


def test_flaky_tasks_under_repeat() -> None:
    baseline = results({"stable": (True, True, True), "was-flaky": (True, False, True)})
    current = results({"stable": (True, False, True), "was-flaky": (True, True, True)})

    comparison = compare(baseline, current)

    changes = {t.id: t.change for t in comparison.tasks}
    assert changes == {"stable": "newly_flaky", "was-flaky": "fixed"}
    assert comparison.regressed
    report = render_markdown(comparison)
    assert "| `stable` | **newly flaky** | pass (3/3) | flaky (2/3) |" in report
    assert "3 runs per task" in report
    assert "- `stable` run 2 (trace `stable-b-1`)" in report


def test_new_and_removed_tasks_are_reported_but_do_not_regress() -> None:
    baseline = results({"kept": (True,), "dropped": (True,)})
    current = results({"kept": (True,), "added": (False,)})

    comparison = compare(baseline, current)

    assert {t.id: t.change for t in comparison.tasks} == {
        "added": "new",
        "dropped": "removed",
        "kept": "unchanged",
    }
    assert not comparison.regressed
    report = render_markdown(comparison)
    assert "| `added` | new | - | fail |" in report
    assert "| `dropped` | removed | pass | - |" in report


def test_per_task_metric_thresholds_flag_passing_tasks() -> None:
    thresholds = parse_thresholds({"tasks": {"steps": {"max_increase": 0}}})
    comparison = compare(
        results({"a": (True,), "b": (True,)}),
        results({"a": (True,), "b": (True,)}, steps=4),
        thresholds,
    )

    assert [t.change for t in comparison.tasks] == ["regressed", "regressed"]
    assert comparison.tasks[0].over_limit == ["steps"]
    assert comparison.regressed
    assert "| **3 → 4** |" in render_markdown(comparison)


def test_suite_metric_thresholds() -> None:
    thresholds = parse_thresholds({"metrics": {"cost_usd.total": {"max_increase_pct": 20}}})
    baseline = results({"a": (True,)}, cost=0.010)

    within = compare(baseline, results({"a": (True,)}, cost=0.0119), thresholds)
    over = compare(baseline, results({"a": (True,)}, cost=0.0121), thresholds)

    assert not within.regressed
    assert over.regressed
    cost_row = next(m for m in over.metrics if m.name == "cost_usd.total")
    assert cost_row.regressed
    report = render_markdown(over)
    row = "| cost (total) | $0.01000 | $0.01210 | +$0.00210 (+21.0%) | **exceeded** (max +20%) |"
    assert row in report
    assert "suite cost (total) over threshold" in report


@pytest.mark.parametrize(
    ("limit", "baseline", "current", "exceeded"),
    [
        (Limit(max_increase_pct=10), 100, 111, True),
        (Limit(max_increase_pct=10), 100, 110, False),
        (Limit(max_increase_pct=10), 100, 50, False),  # improvements never regress
        (Limit(max_increase_pct=30, max_increase=250), 10, 100, False),  # under the floor
        (Limit(max_increase_pct=30, max_increase=250), 1000, 1400, True),
        (Limit(max_increase_pct=30, max_increase=250), 1000, 1200, False),
        (Limit(max_increase=0), 0, 1, True),
        (Limit(max_increase_pct=10), 0, 1, True),  # any growth from zero is infinite %
        (Limit(max_decrease=0), 6, 5, True),
        (Limit(max_decrease=1), 6, 5, False),
        (Limit(max_increase_pct=10), None, 5, False),  # unknown values can't regress
        (Limit(), 1, 100, False),
    ],
)
def test_limits(limit: Limit, baseline: Any, current: Any, exceeded: bool) -> None:
    assert limit.exceeded(baseline, current) is exceeded


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"metrics": {"cost": {"max_increase_pct": 1}}}, "unknown metrics metric"),
        ({"tasks": {"steps": {"max_increse": 1}}}, "tasks.steps"),
        ({"max_newly_failing_tasks": -1}, "non-negative"),
        ({"surprise": 1}, "unknown thresholds key"),
    ],
)
def test_invalid_thresholds(data: Any, message: str) -> None:
    with pytest.raises(SuiteError, match=message):
        parse_thresholds(data)


def test_unknown_costs_render_as_na() -> None:
    unpriced = results({"a": (True,)}, cost=None)
    comparison = compare(unpriced, unpriced)
    assert "| cost (total) | n/a | n/a | n/a |  |" in render_markdown(comparison)


# --- the CLI -------------------------------------------------------------------------------


def test_cli_run_and_compare(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TWEVAL_STEPS", "2")
    (tmp_path / "tw_cli_target.py").write_text(
        "import os, tracewright\n"
        "def answer(task):\n"
        "    for n in range(1, int(os.environ['TWEVAL_STEPS']) + 1):\n"
        "        with tracewright.span(f'step-{n}', attributes={'agent.step': n}):\n"
        "            pass\n"
        "    return task['q'].upper()\n",
        encoding="utf-8",
    )
    (tmp_path / "suite.yaml").write_text(
        "id: cli\n"
        "entrypoint: tw_cli_target:answer\n"
        "tasks:\n"
        "  - id: shout\n"
        "    input: {q: hi}\n"
        "    scorers: [{equals: HI}, {max_steps: 2}]\n",
        encoding="utf-8",
    )
    (tmp_path / "thresholds.yaml").write_text("tasks:\n  steps: {max_increase: 0}\n")
    common = ["--git-sha", "abc", "--git-branch", "main"]

    assert main(["eval", "run", "suite.yaml", "-o", "base.json", *common]) == 0
    assert "1/1 tasks passed" in capsys.readouterr().err
    monkeypatch.setenv("TWEVAL_STEPS", "3")
    assert main(["eval", "run", "suite.yaml", "-o", "cur.json", "--repeat", "2", *common]) == 0

    base = ["eval", "compare", "--baseline", "base.json"]
    assert main([*base, "--current", "base.json"]) == 0
    assert "**No regression.**" in capsys.readouterr().out

    args = [*base, "--current", "cur.json", "--thresholds", "thresholds.yaml", "-o", "r.md"]
    assert main(args) == 1
    report = (tmp_path / "r.md").read_text("utf-8")
    assert "| `shout` | **newly failing** | pass | fail (0/2) | **2 → 3** |" in report


def test_cli_usage_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("id: x\ntasks: []\n", encoding="utf-8")
    assert main(["eval", "run", str(bad)]) == 2
    assert "non-empty" in capsys.readouterr().err

    (tmp_path / "x.json").write_text('{"version": 99}', encoding="utf-8")
    x = str(tmp_path / "x.json")
    assert main(["eval", "compare", "--baseline", x, "--current", x]) == 2
    assert "not a tracewright eval results file" in capsys.readouterr().err
