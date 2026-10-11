#!/usr/bin/env node
// One-shot backfill of the reasoningLevel map onto every auto-added model in
// ZCode's provider_config.json. Run it with ZCode fully closed:
//
//   node scripts/backfill-reasoning.mjs             # write
//   node scripts/backfill-reasoning.mjs --dry-run   # preview only
//
// Refuses to run while ZCode is alive (ZCode would overwrite the file on exit).
// Writes a timestamped backup first, writes atomically, then re-reads and
// confirms that a second pass finds nothing left to change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zcodeProviderConfigPath, isZcodeRunning } from "../src/core/platform.mjs";
import { readConfig, writeConfigAtomic, backfillReasoningMaps } from "../src/config.mjs";

export function runBackfill({
  configPath = zcodeProviderConfigPath(),
  dryRun = false,
  _isRunning = isZcodeRunning,
  log = console.log,
} = {}) {
  if (_isRunning()) {
    throw new Error("ZCode 仍在运行。请先完全退出 ZCode（包括托盘图标）后再执行。");
  }
  const cfg = readConfig(configPath);
  if (!cfg) throw new Error(`未找到 ${configPath}`);
  const providerCount = cfg.config.providerConfigRules.providerRules.length;

  const preview = backfillReasoningMaps(structuredClone(cfg));
  log(`[i] 待补充 ${preview.changed} 个模型，跳过 ${preview.skipped} 个（非自动添加 / 手动规则 / 已隐藏 / 已有映射）`);
  if (dryRun || preview.changed === 0) {
    log(dryRun ? "[i] --dry-run：未写入任何文件。" : "[√] 无需写入。");
    return { changed: preview.changed, written: false };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${configPath}.pre-reasoning-${stamp}.bak`;
  fs.copyFileSync(configPath, backup);

  const res = backfillReasoningMaps(cfg);
  writeConfigAtomic(cfg, configPath);

  const back = readConfig(configPath);
  if (back.config.providerConfigRules.providerRules.length !== providerCount) {
    throw new Error(`回读校验失败：供应商数量变化。原文件已备份至 ${backup}`);
  }
  const again = backfillReasoningMaps(structuredClone(back));
  if (again.changed !== 0) {
    throw new Error(`回读校验失败：仍有 ${again.changed} 个模型缺少映射。原文件已备份至 ${backup}`);
  }

  log(`[√] 已为 ${res.changed} 个模型补充推理强度映射（跳过 ${res.skipped} 个）。`);
  log(`    时间戳备份: ${backup}`);
  log("    现在可以启动 ZCode。");
  return { changed: res.changed, written: true, backup };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    runBackfill({ dryRun: process.argv.includes("--dry-run") });
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(2);
  }
}
