"""LangGraph cyclic engine — coder → executor → evaluator ⟲ / human_approval."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from agent.nodes.coder import coder_node, route_after_coder
from agent.nodes.evaluator import evaluator_node, route_after_evaluator
from agent.nodes.executor import executor_node
from agent.nodes.human_approval import human_approval_node
from agent.state import AgentState

# Shared checkpointer so FastAPI routes can resume the same threads.
_checkpointer = MemorySaver()


def build_graph() -> StateGraph:
    """Construct the uncompiled StateGraph."""
    graph = StateGraph(AgentState)

    graph.add_node("coder", coder_node)
    graph.add_node("executor", executor_node)
    graph.add_node("evaluator", evaluator_node)
    graph.add_node("human_approval", human_approval_node)

    graph.set_entry_point("coder")
    graph.add_conditional_edges(
        "coder",
        route_after_coder,
        {
            "executor": "executor",
            "__end__": END,
        },
    )
    graph.add_edge("executor", "evaluator")
    graph.add_conditional_edges(
        "evaluator",
        route_after_evaluator,
        {
            "human_approval": "human_approval",
            "coder": "coder",
            "__end__": END,
        },
    )
    graph.add_edge("human_approval", END)

    return graph


@lru_cache(maxsize=1)
def get_compiled_graph() -> Any:
    """
    Compile with MemorySaver and interrupt before human_approval
    so reviewers can approve/reject via the API.
    """
    return build_graph().compile(
        checkpointer=_checkpointer,
        interrupt_before=["human_approval"],
    )


def get_checkpointer() -> MemorySaver:
    return _checkpointer
