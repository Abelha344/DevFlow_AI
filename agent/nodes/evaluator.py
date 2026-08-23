"""Evaluator node — decide pass / retry / fail."""

from __future__ import annotations

from typing import Any, Literal

from agent.state import AgentState


def evaluator_node(state: AgentState) -> dict[str, Any]:
    """Inspect pytest result and update iteration counters / failure summary."""
    passed = bool(state.get("tests_passed"))
    iteration = int(state.get("iteration_count") or 0)
    max_iterations = int(state.get("max_iterations") or 3)

    if passed:
        return {
            "status": "evaluating",
            "current_node": "evaluator",
            "logs": ["[evaluator] Tests PASSED — routing to human_approval"],
        }

    next_iteration = iteration + 1
    if next_iteration < max_iterations:
        return {
            "iteration_count": next_iteration,
            "status": "evaluating",
            "current_node": "evaluator",
            "logs": [
                f"[evaluator] Tests FAILED — retry {next_iteration}/{max_iterations - 1} "
                "→ coder"
            ],
        }

    summary = (
        f"Max retries ({max_iterations}) reached. "
        f"Last error:\n{(state.get('error_trace') or 'unknown')[:2000]}"
    )
    return {
        "iteration_count": next_iteration,
        "status": "failed",
        "failure_summary": summary,
        "current_node": "evaluator",
        "logs": [f"[evaluator] Giving up after {max_iterations} attempts"],
    }


def route_after_evaluator(
    state: AgentState,
) -> Literal["human_approval", "coder", "__end__"]:
    """Conditional edge after evaluator."""
    if state.get("tests_passed"):
        return "human_approval"

    iteration = int(state.get("iteration_count") or 0)
    max_iterations = int(state.get("max_iterations") or 3)
    if iteration < max_iterations and state.get("status") != "failed":
        return "coder"

    return "__end__"
