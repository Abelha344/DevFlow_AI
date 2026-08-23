"""Dynamic LLM factory — selects provider from environment."""

from __future__ import annotations

import os
from typing import Any

from dotenv import load_dotenv

load_dotenv()


def _env(name: str, default: str = "") -> str:
    """Read env var and strip whitespace/newlines (common Render paste issue)."""
    value = os.getenv(name, default)
    return value.strip() if value else default


def _provider() -> str:
    return _env("LLM_PROVIDER", "ollama").lower()


def _llm_cache_key() -> tuple[str, ...]:
    """Cache key from env — invalidates when provider/model/key changes."""
    p = _provider()
    if p in ("google", "gemini"):
        return (p, _env("GOOGLE_MODEL", "gemini-2.5-flash"), _env("GOOGLE_API_KEY"))
    if p == "ollama":
        return (p, _env("OLLAMA_MODEL", "qwen2.5:0.5b"), _env("OLLAMA_BASE_URL", "http://localhost:11434"))
    if p == "openai":
        return (p, _env("OPENAI_MODEL", "gpt-4o-mini"), _env("OPENAI_API_KEY"))
    return (p,)


_LLM_CACHE: dict[tuple[str, ...], Any] = {}


def get_llm() -> Any:
    """
    Unified chat model factory.

    Providers (env LLM_PROVIDER):
      - ollama  (default, free): ChatOllama / qwen2.5:0.5b
      - google  (free tier):     ChatGoogleGenerativeAI / gemini-2.5-flash
      - openai  (paid):          ChatOpenAI / gpt-4o-mini
    """
    provider = _provider()
    cache_key = _llm_cache_key()
    if cache_key in _LLM_CACHE:
        return _LLM_CACHE[cache_key]

    llm: Any
    if provider in ("google", "gemini"):
        from langchain_google_genai import ChatGoogleGenerativeAI

        llm = ChatGoogleGenerativeAI(
            model=_env("GOOGLE_MODEL", "gemini-2.5-flash"),
            google_api_key=_env("GOOGLE_API_KEY") or None,
            temperature=0.2,
        )
    elif provider == "ollama":
        from langchain_ollama import ChatOllama

        llm = ChatOllama(
            model=_env("OLLAMA_MODEL", "qwen2.5:0.5b"),
            base_url=_env("OLLAMA_BASE_URL", "http://localhost:11434"),
            temperature=0.2,
        )
    elif provider == "openai":
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=_env("OPENAI_MODEL", "gpt-4o-mini"),
            api_key=_env("OPENAI_API_KEY") or None,
            temperature=0.2,
        )
    else:
        raise ValueError(
            f"Unsupported LLM_PROVIDER={provider!r}. "
            "Use one of: google, ollama, openai."
        )

    _LLM_CACHE[cache_key] = llm
    return llm


def reset_llm_cache() -> None:
    """Clear cached LLM instance (useful in tests)."""
    _LLM_CACHE.clear()
