#!/usr/bin/env bash
# Single-container entrypoint for Hugging Face Spaces (and local smoke tests).
set -euo pipefail

PORT="${PORT:-7860}"
export LLM_PROVIDER="${LLM_PROVIDER:-ollama}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"

mkdir -p /app/output

echo "[devflow] Starting Ollama on ${OLLAMA_BASE_URL}..."
ollama serve &
OLLAMA_PID=$!

echo "[devflow] Waiting for Ollama API..."
for _ in $(seq 1 90); do
  if curl -sf "${OLLAMA_BASE_URL}/api/tags" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sf "${OLLAMA_BASE_URL}/api/tags" >/dev/null 2>&1; then
  echo "[devflow] ERROR: Ollama did not become ready in time." >&2
  exit 1
fi

echo "[devflow] Pulling model ${OLLAMA_MODEL} (first boot may take a few minutes)..."
ollama pull "${OLLAMA_MODEL}"

echo "[devflow] Starting FastAPI on 127.0.0.1:8000..."
cd /app
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 &
UVICORN_PID=$!

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
  echo "[devflow] ERROR: FastAPI did not become ready in time." >&2
  exit 1
fi

echo "[devflow] Configuring Nginx reverse proxy on port ${PORT}..."
export PORT
envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

shutdown() {
  echo "[devflow] Shutting down..."
  kill "${UVICORN_PID}" "${OLLAMA_PID}" 2>/dev/null || true
  wait "${UVICORN_PID}" "${OLLAMA_PID}" 2>/dev/null || true
}
trap shutdown EXIT TERM INT

echo "[devflow] Ready at http://0.0.0.0:${PORT}"
exec nginx -g 'daemon off;'
