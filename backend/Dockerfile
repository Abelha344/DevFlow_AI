FROM python:3.10-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt \
    && pip install torch --index-url https://download.pytorch.org/whl/cpu

COPY agent ./agent
COPY backend ./backend
COPY scripts/render-start.sh ./scripts/render-start.sh
COPY .env.example ./.env.example

RUN chmod +x ./scripts/render-start.sh

EXPOSE 8000

CMD ["./scripts/render-start.sh"]
