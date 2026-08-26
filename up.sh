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
REDIS_USERNAME="${REDIS_USERNAME:-}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_TLS_ENABLED="${REDIS_TLS_ENABLED:-false}"

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
sed -e "s|__REDIS_ADDR__|${REDIS_ADDR}|g" \
    -e "s|__REDIS_USERNAME__|${REDIS_USERNAME}|g" \
    -e "s|__REDIS_PASSWORD__|${REDIS_PASSWORD}|g" \
    -e "s|__REDIS_TLS_ENABLED__|${REDIS_TLS_ENABLED}|g" \
    livekit.yaml.tmpl > livekit.yaml
echo "rendered livekit.yaml (redis -> ${REDIS_ADDR})"

# --- up --------------------------------------------------------------------
# Linux server: host networking (docker-compose.yml). Binds the full UDP range
# from livekit.yaml directly on the host with NO NAT/port-mapping — required so
# every WebRTC media port LiveKit picks is reachable. The Windows compose
# (bridge + published ports) is only for local Docker Desktop, which has no host
# networking; use up.ps1 there.
docker compose -f docker-compose.yml up --build -d
echo "livekit up. logs: docker compose logs -f livekit"
