param(
  [string]$ProjectRoot = "C:\Users\nilay\Downloads\Market-pulse-main\Market-pulse-main",
  [string]$Days = "7"
)

$ErrorActionPreference = "Stop"

if (-not $env:SUPABASE_URL) {
  throw "SUPABASE_URL is not set in this shell or machine environment."
}

if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
  throw "SUPABASE_SERVICE_ROLE_KEY is not set in this shell or machine environment."
}

$env:OFFICIAL_INGEST_DAYS = $Days
Set-Location (Join-Path $ProjectRoot "netlify\functions")
npm.cmd run ingest:official

