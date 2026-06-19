#!/usr/bin/env bash
# Start the LiveKit Egress service (recording / composite).
#   ./up_egress.sh
#
# Egress connects to the SAME livekit + redis as the server. Config lives in
# egress.yaml (api_key/secret + ws_url + redis). Run up.sh FIRST so livekit is
# already up; egress just attaches.
#   docker logs -f egress     # watch
#   docker rm -f egress       # stop
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

# --- check egress config exists --------------------------------------------
if [[ ! -f egress.yaml ]]; then
  echo "ERROR: egress.yaml missing (api_key/secret + ws_url + redis)." >&2
  exit 1
fi

# Pinned egress image. Override via .env EGRESS_IMAGE. Find current stable:
#   docker run --rm livekit/egress:latest --version
image="${EGRESS_IMAGE:-livekit/egress:v1.9}"

# --- up --------------------------------------------------------------------
# host networking (Linux): egress reaches livekit (ws_url) + redis on the same
# box directly, no NAT remap. Recreate if already present.
docker rm -f egress >/dev/null 2>&1 || true
docker run -d \
  --name egress \
  --restart unless-stopped \
  --network host \
  -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
  -v "$(pwd)/egress.yaml:/etc/egress.yaml:ro" \
  "$image"

echo "egress up ($image). logs: docker logs -f egress"
