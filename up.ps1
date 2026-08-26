# Start LiveKit ONLY if the external redis (from .env) is reachable.
#   .\up.ps1
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

if (-not $env:REDIS_ADDR) {
    Write-Error "REDIS_ADDR not set in .env"
    exit 1
}

$redisAddr = $env:REDIS_ADDR
$host_ = $redisAddr.Split(':')[0]
if ($redisAddr.Contains(':')) { $port = $redisAddr.Split(':')[-1] } else { $port = '6379' }

# --- check redis addr has host + port --------------------------------------
if (-not $host_ -or -not $port) {
    Write-Error "ERROR: REDIS_ADDR must be host:port (got '${redisAddr}')."
    exit 1
}
Write-Host "redis addr ${host_}:${port} OK."

# --- render config from template -------------------------------------------
# replace __REDIS_*__ placeholders with values from .env.
$redisUser = if ($env:REDIS_USERNAME) { $env:REDIS_USERNAME } else { '' }
$redisPass = if ($env:REDIS_PASSWORD) { $env:REDIS_PASSWORD } else { '' }
$redisTls  = if ($env:REDIS_TLS_ENABLED) { $env:REDIS_TLS_ENABLED } else { 'false' }
(Get-Content livekit.yaml.tmpl -Raw).
    Replace('__REDIS_ADDR__', $redisAddr).
    Replace('__REDIS_USERNAME__', $redisUser).
    Replace('__REDIS_PASSWORD__', $redisPass).
    Replace('__REDIS_TLS_ENABLED__', $redisTls) |
    Set-Content livekit.yaml -Encoding utf8 -NoNewline
Write-Host "rendered livekit.yaml (redis -> ${redisAddr})"

# --- up --------------------------------------------------------------------
docker compose -f docker-compose.windows.yml up --build -d
Write-Host "livekit up. logs: docker compose logs -f livekit"
