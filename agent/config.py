"""Dynamic LLM factory — selects provider from environment."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from dotenv import load_dotenv

load_dotenv()


def _provider() -> str:
    return os.getenv("LLM_PROVIDER", "ollama").strip().lower()


@lru_cache(maxsize=1)
def get_llm() -> Any:
    """
    Unified chat model factory.

    Providers (env LLM_PROVIDER):
      - ollama  (default, free): ChatOllama / qwen2.5:0.5b
      - google  (free tier):     ChatGoogleGenerativeAI / gemini-1.5-flash
      - openai  (paid):          ChatOpenAI / gpt-4o-mini
    """
    provider = _provider()

    if provider in ("google", "gemini"):
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(
            model=os.getenv("GOOGLE_MODEL", "gemini-1.5-flash"),
            google_api_key=os.getenv("GOOGLE_API_KEY"),
            temperature=0.2,
        )

    if provider == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(
            model=os.getenv("OLLAMA_MODEL", "qwen2.5:0.5b"),
            base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
            temperature=0.2,
        )

    if provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            api_key=os.getenv("OPENAI_API_KEY"),
            temperature=0.2,
        )

    raise ValueError(
        f"Unsupported LLM_PROVIDER={provider!r}. "
        "Use one of: google, ollama, openai."
    )


def reset_llm_cache() -> None:
    """Clear cached LLM instance (useful in tests)."""
    get_llm.cache_clear()
