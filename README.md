---
title: DevFlow AI
emoji: 🤖
colorFrom: teal
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# DevFlow AI — Self-Correcting Code Generation & CI/CD Debugger Agent

Production-oriented LangGraph agent that **writes Python + pytest**, executes tests, **self-corrects up to 3 times**, then pauses for **human approval** before completion.

## Architecture

```
Coder → Executor (pytest) → Evaluator ──pass──► Human Approval → END
              ▲                  │
              └──── fail (<3) ───┘
                     fail (≥3) → END (failure summary)
```

| Layer | Path | Role |
|-------|------|------|
| LLM factory | `agent/config.py` | **Ollama (default)** / Google Gemini / OpenAI via `LLM_PROVIDER` |
| State machine | `agent/graph.py` + `agent/nodes/` | Cyclic LangGraph with `MemorySaver` + `interrupt_before` |
| API | `backend/app/` | FastAPI run / approve / state (+ NDJSON stream) |
| UI | `frontend/src/` | React + Vite + Tailwind dashboard |
| Packing (local) | `docker-compose.yml` | Backend `:8001`, Frontend `:3000` (requires external Ollama) |
| Packing (HF / single container) | root `Dockerfile` + `scripts/start.sh` | Ollama + FastAPI + Nginx on port `7860` (all-in-one) |

**Choose a deployment path:**

| Goal | Command | URL |
|------|---------|-----|
| Local dev (two containers) | `docker compose up` | http://localhost:3000 |
| Hugging Face Space | push repo → HF builds root `Dockerfile` | `https://<user>-<space>.hf.space` |
| Test HF image locally | `docker build -t devflow-ai . && docker run -p 7860:7860 devflow-ai` | http://localhost:7860 |

## LLM providers (default: free Ollama + Qwen)

**Default:** `ollama` with `qwen2.5:0.5b` — **100% free**, no cloud API key required.

Set everything in `.env`. Change `LLM_PROVIDER`, restart the backend, and you're on a different model.

| `LLM_PROVIDER` | Default model | Cost | API key needed? |
|----------------|---------------|------|-----------------|
| **`ollama`** *(default)* | `qwen2.5:0.5b` | Free | No — needs [Ollama](https://ollama.com) running |
| `google` | `gemini-1.5-flash` | Free tier | Yes — [Google AI Studio](https://aistudio.google.com/apikey) |
| `openai` | `gpt-4o-mini` | Paid | Yes — [OpenAI](https://platform.openai.com/api-keys) |

### Default setup (Ollama + Qwen)

1. Install and start Ollama: https://ollama.com  
2. Pull the model:

```bash
ollama pull qwen2.5:0.5b
```

3. Copy env and run:

```bash
cp .env.example .env
# LLM_PROVIDER=ollama is already the default — no API key required

docker compose up          # fast restart (existing images)
# docker compose up --build  # first time or after code changes
```

> **Docker Compose does not bundle Ollama.** It expects Ollama reachable at `OLLAMA_BASE_URL` (see below). For an all-in-one image with Ollama inside, use the root `Dockerfile` (Hugging Face section).

**Docker note:** With `docker compose`, Ollama must run on your **host** (default URL below). If you use a separate Ollama container (e.g. ScribeCare), override in `.env`:

```
OLLAMA_BASE_URL=http://scribecare-ollama:11434
```

For Ollama on your host machine while DevFlow runs in Docker (default in `.env.example`):

```
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

### Switch to Google Gemini (still free)

In `.env`:

```env
LLM_PROVIDER=google
GOOGLE_API_KEY=your_key_from_aistudio
```

Restart the backend (`docker compose up` or restart uvicorn).

### Switch to OpenAI GPT (paid)

In `.env`:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini   # optional; this is the default
```

Restart the backend. The dashboard shows `(paid)` next to the active provider.

## Deploy to Hugging Face Spaces (free CPU, single container)

Hugging Face Spaces **does not run `docker-compose.yml`**. Use the **root `Dockerfile`** instead — it bundles everything into one image:

| Component | How it runs in the Space |
|-----------|--------------------------|
| **Ollama** | Installed in the image; `ollama serve` starts in `scripts/start.sh` |
| **Qwen model** | `ollama pull qwen2.5:0.5b` on container boot (100% free, no API key) |
| **FastAPI** | `uvicorn` on `127.0.0.1:8000` (internal only) |
| **React UI** | Static build served by **Nginx** on `$PORT` (default **7860**) |
| **API routing** | Nginx proxies `/api/*` → FastAPI (replaces Vite dev proxy) |

### Create the Space

1. Create a new Space at [huggingface.co/new-space](https://huggingface.co/new-space)
2. Choose **Docker** as the SDK
3. Push this repository (or connect GitHub)
4. HF reads `README.md` frontmatter (`sdk: docker`, `app_port: 7860`) and builds the root `Dockerfile`

### Test the same image locally

```bash
docker build -t devflow-ai .
docker run --rm -p 7860:7860 devflow-ai
```

Open **http://localhost:7860** — UI, `/api/…`, and `/health` all go through Nginx.

> **First boot is slow:** the container pulls `qwen2.5:0.5b` and installs PyTorch. Hugging Face free CPU tier may take several minutes before the Space shows **Running**.

### Optional: switch LLM on Hugging Face

Add Space **Secrets** (Settings → Variables and secrets):

| Secret | Use |
|--------|-----|
| `LLM_PROVIDER=google` + `GOOGLE_API_KEY` | Gemini free tier (no Ollama needed) |
| `LLM_PROVIDER=openai` + `OPENAI_API_KEY` | Paid GPT fallback |

When using cloud LLMs, Ollama still starts but is unused unless `LLM_PROVIDER=ollama`.

## Quick start (Docker Compose — local dev)

Requires **Ollama running separately** (host or another container) with `qwen2.5:0.5b` pulled.

```bash
cp .env.example .env
ollama pull qwen2.5:0.5b
docker compose up
```

- Dashboard: http://localhost:3000  
- API docs: http://localhost:8001/docs  
- Health: http://localhost:8001/health  

> **Note:** Port `8001` is used for the backend because another service (e.g. ScribeCare) may already occupy `8000`. Use `docker compose up --build` only on first run or after changing dependencies.

> **UI changes not showing?** Docker serves a **built** frontend image, not live source files. After editing `frontend/src/`, rebuild and restart:
>
> ```bash
> docker compose build frontend && docker compose up -d
> ```
>
> Or run the Vite dev server for instant reload (uses the same backend on `:8001`):
>
> ```bash
> cd frontend && npm install && npm run dev
> ```
>
> If `docker compose up` fails with **address already in use**, you may have **two Docker engines** (Docker Desktop + system Docker) fighting for the same ports. Use one engine consistently:
>
> ```bash
> docker context use default          # system Docker (same as sudo systemctl restart docker)
> docker compose down
> docker compose build frontend
> docker compose up -d
> ```
>
> Check active context: `docker context ls` (the row with `*` is active).

## Local development

### Backend

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # default is ollama; pull qwen2.5:0.5b first

uvicorn backend.app.main:app --reload --port 8001
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite serves the UI on http://localhost:3000 and proxies `/api` → `http://localhost:8001` (see `vite.config.js`). Run the backend on **8001** so the proxy matches.

## API

### `POST /api/v1/agent/run`

```json
{ "prompt": "Write a function is_palindrome(s) with tests." }
```

Streams **NDJSON** events (`started`, `node`, `paused`, `finished`, `error`). Header `X-Thread-Id` carries the checkpoint thread.

### `POST /api/v1/agent/approve`

```json
{ "thread_id": "<uuid>", "approved": true }
```

Resumes the graph after the `human_approval` interrupt.

### `GET /api/v1/agent/state/{thread_id}`

Returns the latest serialized agent state for UI polling.

### `GET /api/v1/agent/config`

Returns the active `LLM_PROVIDER` and model (shown in the dashboard header).

## Human-in-the-loop

The compiled graph uses `MemorySaver` and `interrupt_before=["human_approval"]`. When pytest passes, the stream emits `paused` and the UI shows **Approve & Push** / **Reject**. Approval injects `approved` into state and resumes the checkpoint.

After you approve or reject, the dashboard shows a **Task completed** bar, highlights the prompt area for the **next request**, and offers **Start new task** (full reset) or **Run next task** (keep reviewing).

Approved runs are saved under `output/{thread_id}/` (`solution.py`, `test_solution.py`, `prompt.txt`). That folder is gitignored, is not a database, and is **ephemeral on Hugging Face** (lost when the Space restarts unless you add persistent storage later).

## Project layout

```
agent/
  config.py          # Dynamic LLM factory (default: ollama)
  state.py           # AgentState TypedDict
  graph.py           # StateGraph + MemorySaver
  nodes/
    coder.py
    executor.py
    evaluator.py
    human_approval.py
backend/
  app/main.py
  app/routes/agent_routes.py
  Dockerfile
frontend/
  src/App.jsx
  src/components/...
  Dockerfile
Dockerfile              # Single-container image (Hugging Face Spaces)
scripts/start.sh        # Ollama + uvicorn + Nginx entrypoint
deploy/nginx.conf.template
.dockerignore
docker-compose.yml      # Local two-container dev only (no bundled Ollama)
requirements.txt
.env.example
output/              # Approved artifacts (gitignored)
```

## License

MIT
