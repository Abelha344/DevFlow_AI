"""LangGraph agent state definition."""

from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, TypedDict

from langgraph.graph.message import add_messages


class AgentState(TypedDict, total=False):
    """Shared state flowing through the self-correcting agent cycle."""

    # User request
    prompt: str

    # Generated artifacts
    code: str
    tests: str

    # Execution / evaluation
    stdout: str
    stderr: str
    error_trace: str
    tests_passed: bool
    iteration_count: int
    max_iterations: int

    # Human-in-the-loop
    status: Literal[
        "idle",
        "coding",
        "executing",
        "evaluating",
        "awaiting_approval",
        "approved",
        "rejected",
        "failed",
        "completed",
    ]
    approved: Optional[bool]
    failure_summary: str
    abort: bool

    # Live log stream for UI
    logs: Annotated[list[str], _append_logs]

    # Optional message history
    messages: Annotated[list[Any], add_messages]

    # Current graph node (for UI visualizer)
    current_node: str


def _append_logs(existing: list[str] | None, new: list[str] | str | None) -> list[str]:
    """Reducer that appends log lines without overwriting history."""
    base = list(existing or [])
    if new is None:
        return base
    if isinstance(new, str):
        base.append(new)
        return base
    base.extend(new)
    return base


def initial_state(prompt: str, max_iterations: int = 3) -> AgentState:
    """Factory for a fresh agent run."""
    return AgentState(
        prompt=prompt,
        code="",
        tests="",
        stdout="",
        stderr="",
        error_trace="",
        tests_passed=False,
        iteration_count=0,
        max_iterations=max_iterations,
        status="idle",
        approved=None,
        failure_summary="",
        abort=False,
        logs=[f"[system] Agent started for prompt: {prompt[:120]}"],
        messages=[],
        current_node="coder",
    )
