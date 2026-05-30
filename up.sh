#!/usr/bin/env bash
# Start LiveKit ONLY if the external redis (from .env) is reachable.
#   ./up.sh
set -euo pipefail
cd "$(dirname "$0")"

# --- load .env -------------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "ERROR: .env missing. Copy .env.example -> .env" >&2
  exit 1
fi
set -a
source .env
set +a

: "${REDIS_ADDR:?REDIS_ADDR not set in .env}"

host="${REDIS_ADDR%%:*}"
if [[ "$REDIS_ADDR" == *:* ]]; then
  port="${REDIS_ADDR##*:}"
else
  port=6379
fi

# --- check redis addr has host + port --------------------------------------
if [[ -z "$host" || -z "$port" ]]; then
  echo "ERROR: REDIS_ADDR must be host:port (got '${REDIS_ADDR}')." >&2
  exit 1
fi
echo "redis addr ${host}:${port} OK."

# --- render config from template -------------------------------------------
# sed (cross-platform, no envsubst dependency). | delimiter to keep ':' safe.
sed "s|__REDIS_ADDR__|${REDIS_ADDR}|g" livekit.yaml.tmpl > livekit.yaml
echo "rendered livekit.yaml (redis -> ${REDIS_ADDR})"

# --- up --------------------------------------------------------------------
docker compose -f docker-compose.windows.yml up --build -d
echo "livekit up. logs: docker compose logs -f livekit"
