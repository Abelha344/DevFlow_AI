"""Agent REST + SSE streaming routes."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from pathlib import Path

from agent.config import DEFAULT_GOOGLE_MODEL, GOOGLE_MODEL_FALLBACKS, google_model
from agent.graph import get_compiled_graph
from agent.state import initial_state

router = APIRouter()

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = ROOT / "output"


def _save_artifacts_enabled() -> bool:
    """When false (cloud default), approve is session-only — no server disk write."""
    raw = os.getenv("SAVE_ARTIFACTS", "true").strip().lower()
    return raw in ("1", "true", "yes", "on")


# In-memory snapshot cache for GET /state (also recoverable via checkpointer).
_THREAD_SNAPSHOTS: dict[str, dict[str, Any]] = {}


class RunRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Feature or bug request")
    max_iterations: int = Field(default=3, ge=1, le=5)


class ApproveRequest(BaseModel):
    thread_id: str
    approved: bool


def _serialize_state(values: dict[str, Any] | None) -> dict[str, Any]:
    if not values:
        return {}
    safe = dict(values)
    # messages may contain non-JSON objects
    if "messages" in safe:
        safe["messages"] = [
            m if isinstance(m, (str, dict)) else getattr(m, "content", str(m))
            for m in (safe["messages"] or [])
        ]
    return safe


def _update_snapshot(thread_id: str, values: dict[str, Any], *, paused: bool = False) -> None:
    snap = _serialize_state(values)
    snap["thread_id"] = thread_id
    snap["paused"] = paused
    if paused:
        snap["status"] = "awaiting_approval"
        snap["current_node"] = "human_approval"
    elif snap.get("status") in ("approved", "rejected"):
        snap["paused"] = False
        snap["current_node"] = "completed"
    _THREAD_SNAPSHOTS[thread_id] = snap


def _push_artifacts(thread_id: str, values: dict[str, Any]) -> str:
    """Save approved code/tests to output/{thread_id}/ on disk."""
    dest = OUTPUT_DIR / thread_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "solution.py").write_text(values.get("code") or "", encoding="utf-8")
    (dest / "test_solution.py").write_text(values.get("tests") or "", encoding="utf-8")
    (dest / "prompt.txt").write_text(values.get("prompt") or "", encoding="utf-8")
    return str(dest.relative_to(ROOT))


@router.get("/config")
async def get_agent_config() -> dict[str, Any]:
    """Expose active LLM provider for the dashboard."""
    import os

    provider = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
    save_artifacts = _save_artifacts_enabled()
    models = {
        "google": google_model(),
        "gemini": google_model(),
        "ollama": os.getenv("OLLAMA_MODEL", "qwen2.5:0.5b").strip(),
        "openai": os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
    }
    model = models.get(provider, "unknown")
    paid = provider == "openai"
    return {
        "provider": provider,
        "model": model,
        "paid": paid,
        "label": f"{provider} / {model}" + (" (paid)" if paid else " (free)"),
        "allowed_libraries": [
            "numpy",
            "pandas",
            "torch",
            "langchain",
            "langgraph",
            "pytest",
            "stdlib",
        ],
        "default_google_model": DEFAULT_GOOGLE_MODEL,
        "google_model_fallbacks": list(GOOGLE_MODEL_FALLBACKS),
        "save_artifacts": save_artifacts,
        "storage_mode": "disk" if save_artifacts else "session",
    }


@router.post("/run")
async def run_agent(body: RunRequest) -> StreamingResponse:
    """Start a LangGraph run and stream NDJSON state events."""
    thread_id = str(uuid.uuid4())
    graph = get_compiled_graph()
    config = {"configurable": {"thread_id": thread_id}}
    state = initial_state(body.prompt, max_iterations=body.max_iterations)

    async def event_stream() -> AsyncIterator[str]:
        yield json.dumps(
            {
                "event": "started",
                "thread_id": thread_id,
                "status": "idle",
                "current_node": "coder",
            }
        ) + "\n"

        try:
            # stream_mode="updates" yields per-node deltas; also sync full state periodically
            async for chunk in _async_stream(graph, state, config):
                yield chunk
        except Exception as exc:  # noqa: BLE001
            _THREAD_SNAPSHOTS[thread_id] = {
                "thread_id": thread_id,
                "status": "failed",
                "failure_summary": str(exc),
                "logs": [f"[api] ERROR: {exc}"],
            }
            yield json.dumps(
                {"event": "error", "thread_id": thread_id, "error": str(exc)}
            ) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"X-Thread-Id": thread_id, "Cache-Control": "no-cache"},
    )


async def _async_stream(graph: Any, state: dict, config: dict) -> AsyncIterator[str]:
    """Run graph.stream in a worker thread and push NDJSON lines."""
    queue: asyncio.Queue[Optional[str]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _worker() -> None:
        thread_id = config["configurable"]["thread_id"]
        try:
            for update in graph.stream(state, config=config, stream_mode="updates"):
                # update: {node_name: partial_state}
                node = next(iter(update.keys()), "unknown")
                snapshot = graph.get_state(config)
                values = snapshot.values if snapshot else {}
                _update_snapshot(thread_id, values, paused=False)
                payload = {
                    "event": "node",
                    "thread_id": thread_id,
                    "node": node,
                    "delta": _serialize_state(update.get(node) or {}),
                    "state": _serialize_state(values),
                }
                loop.call_soon_threadsafe(queue.put_nowait, json.dumps(payload) + "\n")

            snapshot = graph.get_state(config)
            values = snapshot.values if snapshot else {}
            next_nodes = list(snapshot.next) if snapshot and snapshot.next else []
            paused = "human_approval" in next_nodes
            _update_snapshot(thread_id, values, paused=paused)

            payload = {
                "event": "paused" if paused else "finished",
                "thread_id": thread_id,
                "paused": paused,
                "next": next_nodes,
                "state": _serialize_state(
                    {**values, "status": "awaiting_approval" if paused else values.get("status")}
                ),
            }
            loop.call_soon_threadsafe(queue.put_nowait, json.dumps(payload) + "\n")
        except Exception as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(
                queue.put_nowait,
                json.dumps(
                    {
                        "event": "error",
                        "thread_id": thread_id,
                        "error": str(exc),
                    }
                )
                + "\n",
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, _worker)

    thread_id = config["configurable"]["thread_id"]
    heartbeat_interval = 15.0

    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=heartbeat_interval)
        except asyncio.TimeoutError:
            # Keep nginx/browser connections alive during long LLM / pytest work
            yield json.dumps({"event": "heartbeat", "thread_id": thread_id}) + "\n"
            continue
        if item is None:
            break
        yield item


@router.post("/approve")
async def approve_agent(body: ApproveRequest) -> dict[str, Any]:
    """Resume a paused graph after human review."""
    graph = get_compiled_graph()
    config = {"configurable": {"thread_id": body.thread_id}}

    snapshot = graph.get_state(config)
    if snapshot is None or not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown thread_id")

    next_nodes = list(snapshot.next) if snapshot.next else []
    if "human_approval" not in next_nodes:
        raise HTTPException(
            status_code=409,
            detail="Thread is not awaiting human approval",
        )

    # Inject decision, then resume from interrupt
    graph.update_state(
        config,
        {
            "approved": body.approved,
            "status": "awaiting_approval",
            "logs": [
                f"[api] Human decision: {'APPROVED' if body.approved else 'REJECTED'}"
            ],
        },
    )

    final_values: dict[str, Any] = {}
    for update in graph.stream(None, config=config, stream_mode="updates"):
        snap = graph.get_state(config)
        final_values = snap.values if snap else {}
        _update_snapshot(body.thread_id, final_values, paused=False)

    status = "approved" if body.approved else "rejected"
    push_path = ""
    artifacts_saved = False
    if body.approved and final_values:
        if _save_artifacts_enabled():
            push_path = _push_artifacts(body.thread_id, final_values)
            artifacts_saved = True
            log_line = f"[push] Saved to {push_path}"
        else:
            log_line = "[approval] Accepted (session only — use Download in the UI; not saved on server disk)"
        final_values = {
            **final_values,
            "status": status,
            "current_node": "completed",
            "paused": False,
            "push_path": push_path,
            "artifacts_saved": artifacts_saved,
            "logs": list(final_values.get("logs") or []) + [log_line],
        }
    elif final_values:
        final_values = {
            **final_values,
            "status": status,
            "current_node": "completed",
            "paused": False,
        }
    _update_snapshot(body.thread_id, final_values or {"status": status}, paused=False)

    return {
        "thread_id": body.thread_id,
        "approved": body.approved,
        "status": status,
        "push_path": push_path,
        "artifacts_saved": artifacts_saved,
        "storage_mode": "disk" if artifacts_saved else "session",
        "state": _serialize_state(final_values),
    }


@router.get("/state/{thread_id}")
async def get_state(thread_id: str) -> dict[str, Any]:
    """Fetch current execution state for frontend rendering."""
    if thread_id in _THREAD_SNAPSHOTS:
        return _THREAD_SNAPSHOTS[thread_id]

    graph = get_compiled_graph()
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = graph.get_state(config)
    if snapshot is None or not snapshot.values:
        raise HTTPException(status_code=404, detail="Unknown thread_id")

    next_nodes = list(snapshot.next) if snapshot.next else []
    paused = "human_approval" in next_nodes
    _update_snapshot(thread_id, snapshot.values, paused=paused)
    return _THREAD_SNAPSHOTS[thread_id]
