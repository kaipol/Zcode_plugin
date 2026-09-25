# zcode-suite uninstaller for Windows (PowerShell).
# usage: powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Force]
param(
  [switch]$Force
)
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "[i] uninstall: restore baseline asar + remove repair trigger + remove skill/command"
$rf = if ($Force) { "--force" } else { "" }
node bin/zcode-suite.mjs unwatch
node bin/zcode-suite.mjs restore $rf
node -e "const fs=require('fs'),os=require('os'),path=require('path');for(const t of [path.join(os.homedir(),'.zcode','skills','model-hub'),path.join(os.homedir(),'.zcode','commands','pull-models.md')]){fs.rmSync(t,{recursive:true,force:true});console.log('removed:',t);}"
Write-Host "[i] done. Fully quit and restart ZCode. Provider config untouched."
