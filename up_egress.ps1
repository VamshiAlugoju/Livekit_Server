# Start the LiveKit Egress service (recording / composite).
#   .\up_egress.ps1
#
# Egress connects to the SAME livekit + redis as the server. Config lives in
# egress.yaml (api_key/secret + ws_url + redis). Run up.ps1 FIRST so livekit is
# already up; egress just attaches.
#   docker logs -f egress     # watch
#   docker rm -f egress       # stop
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# --- load .env -------------------------------------------------------------
if (-not (Test-Path .env)) {
    Write-Error "ERROR: .env missing. Copy .env.example -> .env"
    exit 1
}
Get-Content .env | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $kv = $line -split '=', 2
    if ($kv.Count -eq 2) {
        Set-Item -Path "Env:$($kv[0].Trim())" -Value $kv[1].Trim()
    }
}

# --- check egress config exists --------------------------------------------
if (-not (Test-Path egress.yaml)) {
    Write-Error "ERROR: egress.yaml missing (api_key/secret + ws_url + redis)."
    exit 1
}

# Pinned egress image. Override via .env EGRESS_IMAGE. Find current stable:
#   docker run --rm livekit/egress:latest --version
$image = if ($env:EGRESS_IMAGE) { $env:EGRESS_IMAGE } else { 'livekit/egress:v1.9' }

# --- up --------------------------------------------------------------------
# Docker Desktop (Windows) has no host networking; egress.yaml ws_url/redis must
# point at host-reachable addresses (e.g. host.docker.internal or the LAN IP).
if (docker ps -a --filter 'name=^egress$' --format '{{.Names}}') {
    docker rm -f egress | Out-Null
}
docker run -d `
    --name egress `
    --restart unless-stopped `
    -e EGRESS_CONFIG_FILE=/etc/egress.yaml `
    -v "$($PWD.Path)\egress.yaml:/etc/egress.yaml:ro" `
    $image

Write-Host "egress up ($image). logs: docker logs -f egress"
