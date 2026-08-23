#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT:-8000}"
echo "[devflow] PORT=${PORT} LLM_PROVIDER=${LLM_PROVIDER:-unset}"
echo "[devflow] Starting uvicorn backend.app.main:app ..."
exec uvicorn backend.app.main:app --host 0.0.0.0 --port "$PORT"
