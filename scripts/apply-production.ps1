$ErrorActionPreference = 'Stop'

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  Write-Host "`n=== $Label ===" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

Invoke-External 'Switch to main' { git switch main }
Invoke-External 'Pull latest main' { git pull origin main }
Invoke-External 'Show release commit' { git log -1 --oneline }
Invoke-External 'Validate full D1 migration chain locally' { npm run test:migrations }
Invoke-External 'List pending remote D1 migrations' { npx wrangler d1 migrations list DB --remote }
Invoke-External 'Apply pending remote D1 migrations' { npx wrangler d1 migrations apply DB --remote }
Invoke-External 'Verify remote D1 migration queue is empty' { npx wrangler d1 migrations list DB --remote }
Invoke-External 'Worker deploy dry-run' { npx wrangler deploy --dry-run }
Invoke-External 'Deploy Worker' { npx wrangler deploy }

if ($env:RELAY_URL) {
  Write-Host "`n=== Relay health ===" -ForegroundColor Cyan
  $healthUrl = "$($env:RELAY_URL.TrimEnd('/'))/health"
  $health = Invoke-RestMethod -Method Get -Uri $healthUrl
  $health | ConvertTo-Json -Depth 6
  if (-not $health.ok) {
    throw 'Relay health check did not return ok=true.'
  }
} else {
  Write-Host "`nRELAY_URL is not set; unauthenticated /health verification was skipped." -ForegroundColor Yellow
}

Write-Host "`nProduction apply completed. GPT Instructions and Action schema were not modified by this script." -ForegroundColor Green
