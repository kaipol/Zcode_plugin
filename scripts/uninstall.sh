#!/usr/bin/env bash
# zcode-suite uninstaller (macOS / Linux):
# restore the baseline asar + remove the repair trigger + remove the
# user-space skill/command. Pass --force to override state guards.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[i] 卸载: 还原基线 app.asar + 卸载触发器 + 移除 skill/command（两边配置文件不动）"
node bin/zcode-suite.mjs unwatch || true
node bin/zcode-suite.mjs restore "$@"
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
for (const t of [path.join(os.homedir(), ".zcode", "skills", "model-hub"), path.join(os.homedir(), ".zcode", "commands", "pull-models.md")]) {
  fs.rmSync(t, { recursive: true, force: true });
  console.log("removed:", t);
}
'
echo "[√] 完成。供应商配置 ~/.zcode/v2/provider_config.json 未改动（如需清理请手动编辑）。"
echo "[i] 套件状态目录 ~/.zcode/zcode-suite/ 已保留（含基线备份）；确认不再需要后可手动删除。"
