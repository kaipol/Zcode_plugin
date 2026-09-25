# zcode-suite one-click installer for Windows (PowerShell).
# usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Only modelhub|zcodeplus] [-ForceClose] [-Resources <dir>]
param(
  [string]$Only = "",
  [switch]$ForceClose,
  [string]$Resources = ""
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host "[x] Node.js >= 18 required: https://nodejs.org" -ForegroundColor Red; exit 1 }
$major = [int]($node.Version.Split(".")[0])
if ($major -lt 18) { Write-Host "[x] Node.js >= 18 required (current $($node.Version))" -ForegroundColor Red; exit 1 }

$args = @()
if ($Only) { $args += @("--only", $Only) }
if ($ForceClose) { $args += "--force-close" }
if ($Resources) { $args += @("--resources", $Resources) }

Write-Host "[i] one-click install zcode-suite (model-hub + zcode+): one backup, one repack, one repair trigger"
node bin/zcode-suite.mjs install @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "[i] done. Fully quit and restart ZCode to see both buttons."
