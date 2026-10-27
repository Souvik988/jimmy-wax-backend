# Starts the whole LOCAL backend: Postgres/Redis (docker), API :4000, reads :4001, workers, gateway :8080, admin :3177.
# Usage (from the backend folder):  powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1 [-Reset]
param([switch]$Reset)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $root
docker compose -f "$repo/infrastructure/local/docker-compose.yml" up -d | Out-Null
Start-Sleep -Seconds 6
Set-Location $root
$env:NODE_OPTIONS = '--max-old-space-size=768'
if ($Reset) {
  pnpm exec tsx scripts/db-reset.ts jimmywax_dev --seed
  $env:TEST_DB_NAME = 'jimmywax_dev'; pnpm exec tsx scripts/dev-seed.ts   # optional demo orders; delete this line for a clean store
}
$pgPort = if ($env:PG_HOST_PORT) { $env:PG_HOST_PORT } else { '54422' }
$pg = "postgres://{0}:{1}@127.0.0.1:$pgPort/jimmywax_dev"
# MEDIA_PUBLIC_ALLOW_UNAPPROVED is a development bridge: the dashboard's media library still previews drafts through the public URL.
# Production refuses it (the dashboard should preview through GET /v1/admin/media-files/{sha}/{file}).
$common = @{ NODE_ENV = 'development'; LOG_LEVEL = 'info'; STORAGE_DIR = "$repo/.data/storage"; SMS_PROVIDER = 'console'; MEDIA_PUBLIC_ALLOW_UNAPPROVED = 'true';
             FEATURE_CHECKOUT = 'true'; FEATURE_COD = 'true'; FEATURE_ONLINE_PAYMENTS = 'false'; PAYMENT_PROVIDER = 'none'; STOREFRONT_ORIGIN = 'http://localhost:5174';
             CORS_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:3200' }
# Optional git-ignored backend/.env (KEY=VALUE lines) overrides the defaults above, e.g. Razorpay TEST credentials.
$dotenv = Join-Path $root '.env'
if (Test-Path $dotenv) {
  foreach ($line in Get-Content $dotenv) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $common[$Matches[1]] = $Matches[2] }
  }
  Write-Host "loaded overrides from backend/.env: $((Get-Content $dotenv | Where-Object { $_ -match '^\s*[A-Z]' } | ForEach-Object { ($_ -split '=')[0] }) -join ', ')"
}
function Start-Svc($name, $dir, $extra) {
  $e = $common.Clone(); foreach ($k in $extra.Keys) { $e[$k] = $extra[$k] }
  $envs = ($e.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)';" }) -join ' '
  Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoProfile","-Command","$envs Set-Location '$root/$dir'; pnpm exec tsx src/main.ts" | Out-Null
  Write-Host "started $name"
}
Start-Svc 'commerce-api' 'apps/commerce-api' @{ PORT = '4000'; DATABASE_URL = ($pg -f 'jw_api_login','jw_api_dev') }
Start-Svc 'experience-api' 'apps/experience-api' @{ PORT = '4001'; DATABASE_URL = ($pg -f 'jw_experience_login','jw_experience_dev') }
Start-Svc 'workers' 'apps/workers' @{ DATABASE_URL = ($pg -f 'jw_worker_login','jw_worker_dev') }
Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoProfile","-Command","Set-Location '$root'; pnpm exec tsx scripts/dev-gateway.ts" | Out-Null
Write-Host "gateway on http://localhost:8080  (Android emulator: http://10.0.2.2:8080)"
