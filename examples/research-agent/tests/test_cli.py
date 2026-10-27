from __future__ import annotations

import pytest

from research_agent.cli import main


def test_cli_runs_mock_scenario_and_prints_span_tree(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["--scenario", "calculator-recovery", "--mock-latency", "0", "--print-spans"])

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "A: Apollo 11 returned about 5.6%" in out
    assert "agent  research-agent" in out
    assert "tool   calculator" in out
    assert "ERROR invalid syntax" in out


def test_cli_lists_scenarios(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--list-scenarios"]) == 0
    out = capsys.readouterr().out
    for name in ("apollo-gap", "calculator-recovery", "parallel-lookup"):
        assert name in out


def test_cli_requires_question_for_real_backends(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--backend", "anthropic"]) == 2
    assert "question is required" in capsys.readouterr().err
