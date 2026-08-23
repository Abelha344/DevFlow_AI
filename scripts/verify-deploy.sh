#!/usr/bin/env bash
# End-to-end smoke test for production API.
# Usage: ./scripts/verify-deploy.sh https://YOUR-SERVICE.onrender.com
set -euo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "Usage: $0 https://your-service.onrender.com" >&2
  exit 1
fi
BASE="${BASE%/}"

echo "==> GET $BASE/health"
HEALTH=$(curl -sS -w "\nHTTP:%{http_code}" "$BASE/health" || true)
echo "$HEALTH"
echo "$HEALTH" | grep -q 'HTTP:200' || { echo "FAIL: /health not 200"; exit 1; }
echo "$HEALTH" | grep -q '"status":"ok"' || { echo "FAIL: /health body unexpected"; exit 1; }

echo "==> GET $BASE/api/v1/agent/config"
CONFIG=$(curl -sS -w "\nHTTP:%{http_code}" "$BASE/api/v1/agent/config" || true)
echo "$CONFIG"
echo "$CONFIG" | grep -q 'HTTP:200' || { echo "FAIL: /config not 200"; exit 1; }
echo "$CONFIG" | grep -q '"provider":"google"' || { echo "WARN: LLM_PROVIDER may not be google on Render"; }

echo "OK — backend is live. Set VITE_API_BASE=$BASE on Vercel and redeploy frontend."
