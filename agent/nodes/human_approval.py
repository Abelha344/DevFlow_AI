"""Human approval node — pause point for HITL review."""

from __future__ import annotations

from typing import Any

from agent.state import AgentState


def human_approval_node(state: AgentState) -> dict[str, Any]:
    """
    Mark state as awaiting / resolved human review.

    The graph uses `interrupt_before=["human_approval"]` so execution pauses
    *before* this node until POST /api/v1/agent/approve resumes the thread.
    On resume, `approved` is injected into state by the API layer.
    """
    approved = state.get("approved")

    if approved is True:
        return {
            "status": "approved",
            "current_node": "completed",
            "paused": False,
            "logs": ["[human_approval] Code APPROVED — ready to push"],
        }

    if approved is False:
        return {
            "status": "rejected",
            "current_node": "completed",
            "paused": False,
            "logs": ["[human_approval] Code REJECTED by reviewer"],
        }

    # Should rarely run without a decision because of interrupt_before,
    # but keep a safe idle marker for state polling.
    return {
        "status": "awaiting_approval",
        "current_node": "human_approval",
        "logs": ["[human_approval] Waiting for human decision"],
    }
