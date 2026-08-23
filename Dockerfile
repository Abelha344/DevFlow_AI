# Hugging Face Spaces / single-container production image.
# Combines: React (Nginx) + FastAPI + Ollama (qwen2.5:0.5b) in one process tree.
#
# Local multi-container dev still uses docker-compose.yml + backend/frontend Dockerfiles.

# ── Stage 1: build React dashboard ───────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ .
# Same-origin /api — Nginx proxies to uvicorn inside this container
ENV VITE_API_BASE=""
RUN npm run build

# ── Stage 2: runtime (Ollama + FastAPI + Nginx) ──────────────────────────────
FROM python:3.10-slim-bookworm

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=7860 \
    LLM_PROVIDER=ollama \
    OLLAMA_BASE_URL=http://127.0.0.1:11434 \
    OLLAMA_MODEL=qwen2.5:0.5b

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    gettext-base \
    nginx \
    zstd \
    && curl -fsSL https://ollama.com/install.sh | sh \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt \
    && pip install torch --index-url https://download.pytorch.org/whl/cpu

COPY agent ./agent
COPY backend ./backend
COPY --from=frontend-build /frontend/dist /usr/share/nginx/html
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY scripts/start.sh /app/start.sh

RUN chmod +x /app/start.sh \
    && mkdir -p /app/output

EXPOSE 7860

CMD ["/app/start.sh"]
