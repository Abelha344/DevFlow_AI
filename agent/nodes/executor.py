"""Executor node — writes artifacts to a temp dir and runs pytest."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from agent.state import AgentState


def executor_node(state: AgentState) -> dict[str, Any]:
    """Persist code/tests and execute pytest via subprocess."""
    code = state.get("code") or ""
    tests = state.get("tests") or ""
    workdir = Path(tempfile.mkdtemp(prefix="devflow_agent_"))

    try:
        (workdir / "solution.py").write_text(code, encoding="utf-8")
        (workdir / "test_solution.py").write_text(tests, encoding="utf-8")

        result = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "--tb=short", "test_solution.py"],
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=120,
        )
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        passed = result.returncode == 0

        combined = (stdout + "\n" + stderr).strip()
        return {
            "stdout": stdout,
            "stderr": stderr,
            "tests_passed": passed,
            "error_trace": "" if passed else combined,
            "status": "executing",
            "current_node": "executor",
            "logs": [
                f"[executor] pytest exit={result.returncode} in {workdir}",
                f"[executor] stdout:\n{stdout}" if stdout else "[executor] (no stdout)",
                f"[executor] stderr:\n{stderr}" if stderr else "[executor] (no stderr)",
            ],
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "pytest timed out after 60s",
            "tests_passed": False,
            "error_trace": "pytest timed out after 60s",
            "status": "executing",
            "current_node": "executor",
            "logs": ["[executor] ERROR: pytest timed out after 60s"],
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": str(exc),
            "tests_passed": False,
            "error_trace": str(exc),
            "status": "executing",
            "current_node": "executor",
            "logs": [f"[executor] ERROR: {exc}"],
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
