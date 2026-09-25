#!/usr/bin/env bash
# zcode-suite one-click installer (macOS / Linux): model-hub + zcode+ in one
# pass — one backup, one repack, one auto-repair trigger.
# usage: ./scripts/install.sh [--only modelhub|zcodeplus] [--no-watch]
#        [--no-skill] [--force-close] [--resources <dir>]
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 未找到 node。请先安装 Node.js >= 18: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[x] Node.js >= 18 必需（当前 $(node -v)）" >&2
  exit 1
fi

echo "[i] 一键安装 zcode-suite（model-hub + zcode+：一次备份、一次注入、一个自愈触发器）"
exec node bin/zcode-suite.mjs install "$@"
