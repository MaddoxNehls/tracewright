"""The dogfood eval suite: it matches the committed baseline, and the deliberate
double-check regression makes the comparison fail."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import tracewright
from tracewright.eval import (
    GitInfo,
    RunOutcome,
    compare,
    load_results,
    load_suite,
    load_thresholds,
    render_markdown,
    run_suite,
)

from research_agent.backends.mock import DOUBLE_CHECK_ENV
from research_agent.cli import main
from research_agent.evals import cites_sources

EVALS = Path(__file__).resolve().parents[1] / "evals"
GIT = GitInfo("test", "test")


@pytest.fixture(autouse=True)
def _no_export() -> Any:
    tracewright.init()  # no API key: nothing is sent
    yield
    tracewright.shutdown()


def run_dogfood() -> dict[str, Any]:
    return run_suite(load_suite(EVALS / "suite.yaml"), git=GIT)


def test_suite_matches_the_committed_baseline() -> None:
    current = run_dogfood()

    assert current["aggregate"]["passed_tasks"] == 6
    comparison = compare(
        load_results(EVALS / "baseline.json"), current, load_thresholds(EVALS / "thresholds.yaml")
    )
    # If this fails after an intended behaviour change, regenerate evals/baseline.json.
    assert not comparison.regressed, render_markdown(comparison)
    assert {t.change for t in comparison.tasks} == {"unchanged"}


def test_an_extra_tool_loop_is_caught_as_a_regression(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DOUBLE_CHECK_ENV, "1")
    current = run_dogfood()

    comparison = compare(
        load_results(EVALS / "baseline.json"), current, load_thresholds(EVALS / "thresholds.yaml")
    )

    assert comparison.regressed
    changes = {t.id: t.change for t in comparison.tasks}
    assert changes["apollo-gap"] == "newly_failing"
    assert changes["parallel-lookup"] == "regressed"  # still passes, but one step longer
    report = render_markdown(comparison)
    assert "`max_steps: 5` failed: 6 steps" in report


def test_cites_sources() -> None:
    def run(output: str) -> RunOutcome:
        return RunOutcome(input=None, output=output, trace_id="t", error=None, latency_ms=0)

    assert cites_sources(run("... Sources: apollo-11, sputnik-1.")) == (
        True,
        "apollo-11, sputnik-1",
    )
    assert cites_sources(run("No sources here."))[0] is False


def test_cli_double_check_flag_adds_a_step(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--scenario", "parallel-lookup", "--mock-latency", "0"]) == 0
    assert "(3 steps)" in capsys.readouterr().out
    args = ["--scenario", "parallel-lookup", "--mock-latency", "0", "--mock-double-check"]
    assert main(args) == 0
    assert "(4 steps)" in capsys.readouterr().out
