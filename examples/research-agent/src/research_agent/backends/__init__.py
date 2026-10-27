"""LLM backends. Provider SDK imports are deferred so the mock backend needs no extras."""

from __future__ import annotations

from research_agent.backends.base import Backend, BackendError
from research_agent.backends.mock import DEFAULT_SCENARIO, SCENARIOS, MockBackend

BACKENDS = ("mock", "anthropic", "openrouter", "claude-cli")


def create_backend(
    name: str,
    *,
    model: str | None = None,
    scenario: str = DEFAULT_SCENARIO,
    mock_latency: float = 0.0,
    mock_double_check: bool = False,
) -> Backend:
    if name == "mock":
        return MockBackend(
            scenario,
            model=model or "mock-1",
            latency=mock_latency,
            double_check=mock_double_check,
        )
    if name == "anthropic":
        from research_agent.backends.anthropic_backend import DEFAULT_MODEL, AnthropicBackend

        return AnthropicBackend(model or DEFAULT_MODEL)
    if name == "openrouter":
        from research_agent.backends.openrouter_backend import (
            DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL,
        )
        from research_agent.backends.openrouter_backend import OpenRouterBackend

        return OpenRouterBackend(model or OPENROUTER_DEFAULT_MODEL)
    if name == "claude-cli":
        from research_agent.backends.claude_cli import ClaudeCliBackend

        return ClaudeCliBackend(model)
    raise ValueError(f"unknown backend {name!r}; choose from {', '.join(BACKENDS)}")


__all__ = [
    "BACKENDS",
    "DEFAULT_SCENARIO",
    "SCENARIOS",
    "Backend",
    "BackendError",
    "MockBackend",
    "create_backend",
]
