"""DevFlow AI FastAPI entrypoint."""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Ensure project root is importable when running from backend/
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

load_dotenv(ROOT / ".env")

from backend.app.routes.agent_routes import router as agent_router  # noqa: E402

app = FastAPI(
    title="DevFlow AI",
    description="Self-Correcting Code Generation & CI/CD Debugger Agent",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router, prefix="/api/v1/agent", tags=["agent"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "devflow-ai"}
