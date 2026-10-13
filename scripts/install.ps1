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
# Get-Command's .Version is the file version (System.Version) and is unrelated
# to the node runtime version — ask node itself.
$nodeVersion = (& node --version 2>$null)
if (-not $nodeVersion -or ($nodeVersion -notmatch '^v(\d+)')) {
  Write-Host "[x] 无法运行或解析 node 版本（输出: $nodeVersion）。请确认 Node.js >= 18: https://nodejs.org" -ForegroundColor Red
  exit 1
}
$major = [int]$Matches[1]
if ($major -lt 18) { Write-Host "[x] Node.js >= 18 required (current $nodeVersion)" -ForegroundColor Red; exit 1 }

# $args is a reserved automatic variable in PowerShell — never assign to it.
$cliArgs = @()
if ($Only) { $cliArgs += @("--only", $Only) }
if ($ForceClose) { $cliArgs += "--force-close" }
if ($Resources) { $cliArgs += @("--resources", $Resources) }

Write-Host "[i] one-click install zcode-suite (model-hub + zcode+): one backup, one repack, one repair trigger"
node bin/zcode-suite.mjs install @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "[i] done. Fully quit and restart ZCode to see both buttons."
