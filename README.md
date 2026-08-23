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
| LLM factory | `agent/config.py` | **Ollama (local)** / Google Gemini / OpenAI via `LLM_PROVIDER` |
| State machine | `agent/graph.py` + `agent/nodes/` | Cyclic LangGraph with `MemorySaver` + `interrupt_before` |
| API | `backend/app/` | FastAPI run / approve / state (+ NDJSON stream) |
| UI | `frontend/src/` | React + Vite + Tailwind dashboard |
| Production | **Vercel** + **Render** | Frontend static site + backend Docker API |
| Local dev | `docker-compose.yml` | Backend `:8001`, Frontend `:3000` |

**Deployment paths:**

| Goal | Where | URL |
|------|--------|-----|
| **Production** | Vercel (frontend) + Render (backend) | See [Deploy](#deploy-vercel--render) |
| Local dev (Docker) | `docker compose up` | http://localhost:3000 |
| Local dev (Vite) | `cd frontend && npm run dev` | http://localhost:3000 |

## Deploy (Vercel + Render)

Split deployment: **React on Vercel**, **FastAPI on Render**. Ollama does **not** run in the cloud — use **Google Gemini** on Render (free tier API key).

### Step 1 — Backend on Render

1. Push this repo to GitHub (already done).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint** (or **Web Service** → Docker).
3. Connect the GitHub repo — Render reads `render.yaml` at the repo root.
4. Set **secret** env var: `GOOGLE_API_KEY` (from [Google AI Studio](https://aistudio.google.com/apikey)).
5. After deploy, copy your Render URL, e.g. `https://devflow-api.onrender.com`.
6. Test: `https://devflow-api.onrender.com/health` → `{"status":"ok",...}`

**Render env vars (Dashboard → Environment):**

| Variable | Value |
|----------|--------|
| `LLM_PROVIDER` | `google` |
| `GOOGLE_API_KEY` | your key *(secret)* |
| `GOOGLE_MODEL` | `gemini-2.5-flash` |

> **Model 404 on Render?** Google retired `gemini-1.5-flash` from the API. Set `GOOGLE_MODEL=gemini-2.5-flash` (or try `gemini-3.5-flash` if available in your region).
| `CORS_ORIGINS` | your Vercel URL, e.g. `https://devflow-ai.vercel.app` |

> **Free tier notes:** Render free instances spin down when idle (cold start ~1 min). Agent runs can take several minutes — upgrade or use short prompts if requests timeout. `output/` and in-memory state are **ephemeral** (lost on restart).

### Step 2 — Frontend on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) → import your GitHub repo.
2. The repo includes a root **`vercel.json`** that builds the **Vite frontend only** (avoids the FastAPI detection error).

   **Optional** (either use root `vercel.json` **or** these settings — not both required):

| Setting | Value |
|---------|--------|
| **Root Directory** | `frontend` |
| **Framework Preset** | Vite |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |

3. **Environment Variables** — add **only one** (delete all others Vercel auto-imported from `.env.example`):

| Name | Value |
|------|--------|
| `VITE_API_BASE` | `https://YOUR_RENDER_SERVICE.onrender.com` |

> **Do not** add `LLM_PROVIDER`, `GOOGLE_API_KEY`, Ollama vars, or `CORS_ORIGINS` on Vercel — those belong on **Render**.

4. Deploy. Open your Vercel URL and run a prompt.

5. Go back to Render → set `CORS_ORIGINS` to your exact Vercel URL → redeploy backend.

**If build fails with “No FastAPI entrypoint found”:** Vercel is trying to deploy the Python backend. Push the latest repo (includes root `vercel.json`), then **Redeploy** — do **not** add the `pyproject.toml` FastAPI entrypoint Vercel suggests.

### Step 3 — Re-push after changes

```bash
git add .
git commit -m "Configure Vercel + Render deployment"
git push origin main
```

Vercel and Render auto-redeploy on push (if connected to GitHub).

---

## LLM providers

| `LLM_PROVIDER` | Default model | Local | Render / Vercel |
|----------------|---------------|-------|-----------------|
| **`ollama`** | `qwen2.5:0.5b` | Yes (free) | No — use `google` |
| `google` | `gemini-2.5-flash` | Yes (API key) | **Recommended on Render** |
| `openai` | `gpt-4o-mini` | Yes (paid) | Yes (paid) |

### Local setup (Ollama + Qwen)

```bash
ollama pull qwen2.5:0.5b
cp .env.example .env
docker compose up
```

### Switch to Gemini locally

```env
LLM_PROVIDER=google
GOOGLE_API_KEY=your_key_from_aistudio
```

## Quick start (Docker Compose — local dev)

```bash
cp .env.example .env
ollama pull qwen2.5:0.5b
docker compose up
```

- Dashboard: http://localhost:3000  
- API docs: http://localhost:8001/docs  
- Health: http://localhost:8001/health  

> Port `8001` avoids conflict with other services on `8000`. After UI edits: `docker compose build frontend && docker compose up -d`.

## Local development

### Backend

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu
cp .env.example .env

uvicorn backend.app.main:app --reload --port 8001
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # optional; or rely on vite proxy
npm run dev
```

Vite proxies `/api` → `http://localhost:8001` (see `vite.config.js`).

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

### `GET /api/v1/agent/state/{thread_id}`

Returns the latest serialized agent state for UI polling.

### `GET /api/v1/agent/config`

Returns the active `LLM_PROVIDER` and model (shown in the dashboard header).

## Human-in-the-loop

When pytest passes, the UI shows **Approve & Push** / **Reject**. After approval, artifacts save to `output/{thread_id}/` locally. On Render, that folder is **ephemeral** (lost on restart).

## Project layout

```
agent/                  # LangGraph nodes + LLM factory
backend/
  app/main.py           # FastAPI + CORS (CORS_ORIGINS env)
  Dockerfile            # Render Docker image
frontend/
  src/App.jsx           # VITE_API_BASE → Render API
  vercel.json           # SPA routing on Vercel
  .env.example          # VITE_API_BASE for production
render.yaml             # Render Blueprint
scripts/render-start.sh # uvicorn on $PORT
docker-compose.yml      # Local dev only
requirements.txt
.env.example
output/                 # gitignored
```

## License

MIT
