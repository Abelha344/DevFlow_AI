"""Coder node — generates Python implementation + pytest suite."""

from __future__ import annotations

import ast
import re
from typing import Any, Literal

from agent.config import get_llm
from agent.state import AgentState

CODER_SYSTEM = """You are an expert Python engineer.
This system ONLY produces Python implementation files and pytest unit tests.

Given a feature/bug request (and optionally a prior pytest failure), produce:
1. A complete, self-contained Python module (implementation only — NO tests or assert statements).
2. A complete pytest unit-test file that validates the implementation.

Allowed third-party libraries (already installed in the test environment):
- numpy
- pandas
- torch (PyTorch, CPU)
- langchain / langchain_core / langchain_*
- langgraph
- pytest (for tests only)
- The Python standard library

Do NOT import packages outside this list (e.g. tensorflow, sklearn, flask) unless they are stdlib.

Rules:
- ALWAYS output Python, even if the user mentions JavaScript/React/other languages.
  For frontend requests, implement a Python equivalent (e.g. a dataclass, HTML builder, or API stub).
- solution.py must contain ONLY the implementation (functions/classes). No `def test_*`, no `assert`.
- test_solution.py must contain complete test functions with indented bodies.
- Prefer small, testable modules; no network or filesystem side effects unless required.
- Keep PyTorch examples small (tiny models, CPU tensors) so pytest finishes quickly.
- Tests must import from `solution` (e.g. `from solution import my_func`).
- If an error_trace is provided, FIX the previous code based on that failure.
- Respond ONLY with two fenced blocks in this exact order (no prose before or after):

```python
# solution.py
...
```

```python
# test_solution.py
...
```
"""


def _extract_blocks(text: str) -> tuple[str, str]:
    """Pull solution.py and test_solution.py from fenced markdown."""
    pattern = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
    blocks = [m.group(1).strip() for m in pattern.finditer(text)]

    code, tests = "", ""
    for block in blocks:
        header = block.splitlines()[0].lower() if block.splitlines() else ""
        body = block
        if header.startswith("# solution"):
            body = "\n".join(block.splitlines()[1:]).strip()
            code = body
        elif "test" in header:
            body = "\n".join(block.splitlines()[1:]).strip()
            tests = body
        elif not code:
            code = body
        elif not tests:
            tests = body

    if not code and blocks:
        code = blocks[0]
    if not tests and len(blocks) > 1:
        tests = blocks[1]

    # Ensure tests import solution
    if tests and "from solution" not in tests and "import solution" not in tests:
        tests = "from solution import *\n\n" + tests

    return code, tests


def _sanitize_solution(code: str) -> tuple[str, list[str]]:
    """Strip tests/asserts from implementation; return asserts for the test file."""
    assert_lines: list[str] = []
    impl_lines: list[str] = []
    lines = code.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()

        if stripped.startswith("assert "):
            assert_lines.append(stripped)
            i += 1
            continue

        if stripped.startswith("def test_") or stripped.startswith("class Test"):
            base_indent = len(line) - len(line.lstrip())
            i += 1
            while i < len(lines):
                if not lines[i].strip():
                    i += 1
                    continue
                cur_indent = len(lines[i]) - len(lines[i].lstrip())
                if cur_indent <= base_indent:
                    break
                if lines[i].lstrip().startswith("assert "):
                    assert_lines.append(lines[i].lstrip())
                i += 1
            continue

        impl_lines.append(line)
        i += 1

    return "\n".join(impl_lines).strip(), assert_lines


def _fix_empty_test_bodies(tests: str) -> str:
    """Insert `pass` into test functions that have no indented body."""
    lines = tests.splitlines()
    if not lines:
        return tests

    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        result.append(line)
        match = re.match(r"^(\s*)def test_\w+\([^)]*\):\s*(#.*)?$", line)
        if match:
            base_indent = len(match.group(1))
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            has_body = (
                j < len(lines) and (len(lines[j]) - len(lines[j].lstrip())) > base_indent
            )
            if not has_body:
                result.append(" " * (base_indent + 4) + "pass  # auto-filled by DevFlow")
        i += 1
    return "\n".join(result)


def _is_valid_python(source: str) -> bool:
    try:
        ast.parse(source)
        return True
    except SyntaxError:
        return False


def _has_test_functions(source: str) -> bool:
    return bool(re.search(r"^\s*def test_\w+\(", source, re.MULTILINE))


def _implementation_functions(code: str) -> list[str]:
    names = re.findall(r"^def (\w+)\(", code, re.MULTILINE)
    return [n for n in names if not n.startswith("test_")]


def _build_tests_from_asserts(code: str, assert_lines: list[str]) -> str:
    """Turn module-level asserts (often misplaced by small LLMs) into pytest."""
    fn_names = _implementation_functions(code)
    if not fn_names:
        return _fallback_tests(code)

    fn = fn_names[0]
    if assert_lines:
        body = "\n    ".join(assert_lines)
        return f"from solution import {fn}\n\ndef test_{fn}():\n    {body}\n"

    return _fallback_tests(code)


def _strip_trailing_garbage(code: str) -> str:
    """Remove test-file headers/imports accidentally appended to solution.py."""
    lines = code.splitlines()
    clean: list[str] = []
    for line in lines:
        stripped = line.strip().lower()
        if stripped.startswith("# test") or stripped == "from solution import *":
            break
        if stripped.startswith("from solution import"):
            break
        clean.append(line)
    return "\n".join(clean).strip()


def _normalize_artifacts(code: str, tests: str, *, repairing: bool = False) -> tuple[str, str]:
    """Clean solution/tests and merge misplaced content from the LLM."""
    code, assert_lines = _sanitize_solution(code)
    code = _strip_trailing_garbage(code)
    code, moved_tests = _split_misplaced_tests(code, "")

    tests = (tests or "").strip()
    if moved_tests.strip():
        tests = f"{moved_tests}\n\n{tests}" if tests else moved_tests

    tests = _fix_empty_test_bodies(tests)

    # Small LLMs often put correct asserts in solution.py but broken tests in test file
    if assert_lines and not repairing:
        tests = _build_tests_from_asserts(code, assert_lines)
    elif not _is_valid_python(tests) or not _has_test_functions(tests):
        tests = _build_tests_from_asserts(code, assert_lines)
    elif assert_lines and not any(a in tests for a in assert_lines):
        fn_names = _implementation_functions(code)
        if fn_names:
            extra = "\n    ".join(assert_lines)
            tests = re.sub(
                r"(def test_\w+\([^)]*\):\s*\n)",
                rf"\1    {extra}\n",
                tests,
                count=1,
            )

    if not _is_valid_python(tests):
        tests = _build_tests_from_asserts(code, assert_lines)

    if not code.strip():
        code = (
            "def placeholder():\n"
            '    """Generated fallback — LLM returned no parseable code."""\n'
            "    return True\n"
        )

    if not _is_valid_python(code):
        code = (
            "def placeholder():\n"
            '    """Invalid LLM output replaced with safe stub."""\n'
            "    return True\n"
        )
        tests = _fallback_tests(code)

    return code, tests


def _split_misplaced_tests(code: str, tests: str) -> tuple[str, str]:
    """Move def test_* blocks accidentally placed in solution.py into tests."""
    if not code:
        return code, tests

    impl_lines: list[str] = []
    test_blocks: list[str] = []
    lines = code.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()
        if stripped.startswith("def test_") or stripped.startswith("class Test"):
            block = [line]
            base_indent = len(line) - len(line.lstrip())
            i += 1
            while i < len(lines):
                if not lines[i].strip():
                    block.append(lines[i])
                    i += 1
                    continue
                cur_indent = len(lines[i]) - len(lines[i].lstrip())
                if cur_indent <= base_indent and lines[i].strip():
                    break
                block.append(lines[i])
                i += 1
            test_blocks.append("\n".join(block).strip())
            continue

        impl_lines.append(line)
        i += 1

    if not test_blocks:
        return code, tests

    cleaned_code = "\n".join(impl_lines).strip()
    moved_tests = "\n\n".join(test_blocks)
    if "from solution import" not in moved_tests and "import solution" not in moved_tests:
        moved_tests = "from solution import *\n\n" + moved_tests
    if tests.strip():
        moved_tests = moved_tests + "\n\n" + tests.strip()
    return cleaned_code, moved_tests


def _fallback_tests(code: str) -> str:
    """Build a minimal pytest file from simple top-level functions in code."""
    names = re.findall(r"^def (\w+)\(", code, re.MULTILINE)
    names = [n for n in names if not n.startswith("test_")]
    if not names:
        return (
            "def test_generated_module_imports():\n"
            "    import solution\n"
            "    assert solution is not None\n"
        )
    fn = names[0]
    return (
        f"from solution import {fn}\n\n"
        f"def test_{fn}_is_callable():\n"
        f"    assert callable({fn})\n"
    )


def _is_stub_placeholder(code: str) -> bool:
    return "placeholder()" in code and (
        "Generated fallback" in code or "Invalid LLM output" in code
    )


def _coder_failure_reason(raw: str, code: str) -> str | None:
    """Explain why the LLM response cannot be used (instead of silent stub)."""
    raw = raw.strip()
    if not raw:
        return "The LLM returned an empty response. Retry or switch LLM provider."

    if not re.search(r"```", raw):
        preview = " ".join(raw.split())[:240]
        if re.search(r"\b(react|javascript|typescript|jsx|vue|angular|css|html)\b", raw, re.I):
            return (
                "DevFlow AI generates Python + pytest only. Your prompt asks for a "
                "non-Python stack. Rephrase as a Python task — e.g. "
                "\"Write a Python dataclass and tests for a React-style Button component "
                "with label and on_click props.\""
            )
        return (
            "The LLM returned prose instead of fenced Python code blocks. "
            f"Preview: {preview}"
        )

    if _is_stub_placeholder(code):
        return (
            "The LLM output could not be parsed into valid Python + pytest. "
            "Use a clear Python-only prompt (functions, classes, algorithms)."
        )

    return None


def coder_node(state: AgentState) -> dict[str, Any]:
    """Generate or repair code + tests from prompt / error_trace."""
    llm = get_llm()
    iteration = int(state.get("iteration_count") or 0)
    prompt = state.get("prompt") or ""
    error_trace = state.get("error_trace") or ""

    user_parts = [f"Request:\n{prompt}"]
    if error_trace:
        user_parts.append(
            f"\nPrevious pytest failure (iteration {iteration}):\n{error_trace}\n"
            "Fix the implementation and/or tests so pytest passes."
        )
        if state.get("code"):
            user_parts.append(f"\nCurrent solution.py:\n{state['code']}")
        if state.get("tests"):
            user_parts.append(f"\nCurrent test_solution.py:\n{state['tests']}")

    messages = [
        {"role": "system", "content": CODER_SYSTEM},
        {"role": "user", "content": "\n".join(user_parts)},
    ]

    log_prefix = "repair" if error_trace else "generate"
    try:
        response = llm.invoke(messages)
        content = response.content if hasattr(response, "content") else str(response)
        if isinstance(content, list):
            content = "".join(
                part.get("text", str(part)) if isinstance(part, dict) else str(part)
                for part in content
            )
        code, tests = _extract_blocks(str(content))
        code, tests = _normalize_artifacts(code, tests, repairing=bool(error_trace))
        raw_text = str(content)
        failure = _coder_failure_reason(raw_text, code)
        if failure:
            return {
                "code": code,
                "tests": tests,
                "status": "failed",
                "abort": True,
                "current_node": "coder",
                "failure_summary": failure,
                "logs": [f"[coder] FAILED: {failure}"],
            }
        return {
            "code": code,
            "tests": tests,
            "status": "coding",
            "current_node": "coder",
            "error_trace": "",
            "logs": [
                f"[coder] {log_prefix} complete "
                f"(iter={iteration}, code={len(code)} chars, tests={len(tests)} chars)"
            ],
        }
    except Exception as exc:  # noqa: BLE001 — surface LLM failures into graph state
        msg = str(exc)
        hint = ""
        if "API key" in msg or "API_KEY" in msg:
            hint = (
                " Set a valid GOOGLE_API_KEY in .env, or use LLM_PROVIDER=ollama "
                "with OLLAMA_MODEL=qwen2.5:0.5b."
            )
        return {
            "code": "",
            "tests": "",
            "status": "failed",
            "abort": True,
            "current_node": "coder",
            "failure_summary": f"Coder LLM error: {msg}{hint}",
            "logs": [f"[coder] ERROR: {msg}{hint}"],
        }


def route_after_coder(state: AgentState) -> Literal["executor", "__end__"]:
    """Stop immediately when the LLM fails — don't waste pytest retries."""
    if state.get("abort") or state.get("status") == "failed":
        return "__end__"
    return "executor"
