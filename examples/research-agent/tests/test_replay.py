"""Replaying calculator-recovery with a system hint "fixes" the run.

The first test serves the recording through a fake read API; the second runs the whole
loop against the docker compose stack (skipped when it isn't running).
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
import tracewright
from tracewright.testing import InMemoryExporter

from research_agent.agent import ResearchAgent
from research_agent.backends import MockBackend
from research_agent.cli import main

HINT = "Write calculator expressions with plain numbers only."
API_KEY = "tw_" + "0" * 32
REPO_ROOT = Path(__file__).resolve().parents[3]


def record_calculator_recovery() -> str:
    backend = MockBackend("calculator-recovery")
    agent = ResearchAgent(backend, tags=["scenario:calculator-recovery"])
    return agent.run(backend.scenario.question).trace_id


def test_cli_replay_with_a_system_hint_avoids_the_tool_error(
    exporter: InMemoryExporter,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    trace_id = record_calculator_recovery()
    spans = sorted(exporter.spans, key=lambda s: s["start_time"])
    assert any(s["status"] == "error" for s in spans)

    def read_api(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/v1/runs/{trace_id}"
        return httpx.Response(200, json={"run": {"trace_id": trace_id}, "spans": spans})

    fake_replay = functools.partial(tracewright.replay, transport=httpx.MockTransport(read_api))
    monkeypatch.setattr(tracewright, "replay", fake_replay)
    monkeypatch.setenv("TRACEWRIGHT_API_KEY", API_KEY)

    exit_code = main(
        [
            "--replay", trace_id,
            "--from-step", "3",
            "--override-system-append", HINT,
            "--mock-latency", "0",
            "--print-spans",
        ]
    )  # fmt: skip

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "A: Apollo 11 returned about 5.6%" in out
    assert "(4 steps)" in out
    assert "ERROR" not in out
    step_lines = [line.strip() for line in out.splitlines() if "custom step-" in line]
    assert [line.endswith("(replayed)") for line in step_lines] == [True, True, False, False]
    assert "4 calls served from the recording, 3 live" in out
    assert "diverged from the recording at step 3, call 2" in out


# --- against the real stack -----------------------------------------------------------


def _endpoint() -> str:
    return os.environ.get("TRACEWRIGHT_ENDPOINT", "http://localhost:4318").rstrip("/")


def _compose_api_key() -> str:
    """Create a project and key in the compose ingest container, like the README does."""
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("docker is not installed")
    admin = [docker, "compose", "exec", "-T", "ingest", "/usr/local/bin/tracewright-ingest"]
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}  # Git Bash would mangle the path
    subprocess.run(
        [*admin, "admin", "create-project", "--slug", "replay-e2e", "--name", "Replay e2e"],
        cwd=REPO_ROOT, env=env, capture_output=True, check=False,
    )  # fmt: skip
    created = subprocess.run(
        [*admin, "admin", "create-key", "--project", "replay-e2e"],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=False,
    )  # fmt: skip
    if created.returncode != 0:
        pytest.skip(f"could not create an API key: {created.stderr.strip()}")
    return created.stdout.strip()


@pytest.fixture
def stack() -> tuple[str, str]:
    """(endpoint, api_key) for a running ingest service that has the read API."""
    endpoint = _endpoint()
    try:
        httpx.get(f"{endpoint}/healthz", timeout=2).raise_for_status()
    except httpx.HTTPError:
        pytest.skip(f"no ingest service at {endpoint} (docker compose up -d --build)")
    api_key = os.environ.get("TRACEWRIGHT_E2E_API_KEY") or _compose_api_key()
    probe = httpx.get(
        f"{endpoint}/v1/runs/{'0' * 32}", headers={"Authorization": f"Bearer {api_key}"}
    )
    if probe.headers.get("content-type") != "application/json":
        pytest.skip("the running ingest predates the read API; rebuild it")
    return endpoint, api_key


def wait_for_run(endpoint: str, api_key: str, trace_id: str, spans: int) -> dict[str, Any]:
    """Ingest writes asynchronously after its 202, so poll until every span has landed."""
    deadline = time.monotonic() + 15
    while True:
        response = httpx.get(
            f"{endpoint}/v1/runs/{trace_id}", headers={"Authorization": f"Bearer {api_key}"}
        )
        if response.status_code == 200 and len((body := response.json())["spans"]) == spans:
            return body  # type: ignore[no-any-return]
        if time.monotonic() > deadline:
            raise AssertionError(f"run {trace_id} incomplete: {response.status_code}")
        time.sleep(0.2)


def test_replay_end_to_end(stack: tuple[str, str]) -> None:
    endpoint, api_key = stack
    tracewright.init(api_key=api_key, endpoint=endpoint, flush_interval=0.1)
    try:
        original_id = record_calculator_recovery()
        assert tracewright.flush(10)
        original = wait_for_run(endpoint, api_key, original_id, spans=15)
        assert original["run"]["status"] == "ok"
        assert [s["status"] for s in original["spans"] if s["name"] == "calculator"] == [
            "error",
            "ok",
        ]

        backend = MockBackend("calculator-recovery")
        with tracewright.replay(
            original_id, from_step=3, overrides={"system_append": HINT}
        ) as replay:
            result = ResearchAgent(backend, tags=["replay"]).run(backend.scenario.question)
        assert tracewright.flush(10)
    finally:
        tracewright.shutdown()

    assert replay.trace_id == result.trace_id != original_id
    # root + 4 steps + 4 LLM calls + 3 tool calls
    replayed = wait_for_run(endpoint, api_key, result.trace_id, spans=12)
    spans = replayed["spans"]
    by_id = {s["span_id"]: s for s in spans}
    root = next(s for s in spans if s["parent_span_id"] is None)

    assert root["attributes"]["tracewright.replay_of"] == original_id
    assert root["attributes"]["tracewright.replay_from_step"] == 3
    assert root["attributes"]["tracewright.replay_overrides"] == {"system_append": HINT}
    assert all(s["status"] == "ok" for s in spans), "the hint should avoid the tool error"
    assert "5.6%" in result.answer

    steps = {s["name"]: s for s in spans if s["name"].startswith("step-")}
    assert sorted(steps) == ["step-1", "step-2", "step-3", "step-4"]
    for name in ("step-1", "step-2"):
        assert steps[name]["attributes"]["tracewright.replayed"] is True
        children = [s for s in spans if s["parent_span_id"] == steps[name]["span_id"]]
        assert [s["kind"] for s in children] == ["llm", "tool"]
        assert all(s["attributes"]["tracewright.replayed"] for s in children)
    assert steps["step-3"]["attributes"]["tracewright.replayed"] is False

    live_llm = [
        s for s in spans if s["kind"] == "llm" and not s["attributes"].get("tracewright.replayed")
    ]
    assert len(live_llm) == 2  # steps 1-2 cost zero live calls
    assert all(HINT in s["input"]["system"] for s in live_llm)
    assert replayed["run"]["llm_call_count"] == 4
    assert all(by_id[s["parent_span_id"]]["name"] in ("step-3", "step-4") for s in live_llm)
    print(
        f"\noriginal {original_id}: {len(original['spans'])} spans; "
        f"replay {result.trace_id}: {len(spans)} spans, {replay.served_calls} served, "
        f"{replay.live_calls} live, diverged at {replay.divergence}"
    )
