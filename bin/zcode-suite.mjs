#!/usr/bin/env node
// zcode-suite — unified ZCode desktop plugin: model-hub (model pulling) +
// zcode+ (prompt enhancement) in one install, one backup chain, one repair
// trigger. Zero npm dependencies. Node >= 18 required (global fetch).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { OS as platform, zcodeProviderConfigPath, findZcodeInstall } from "../src/core/platform.mjs";
import { FEATURES, FEATURE_ORDER } from "../src/core/features.mjs";

const VERSION = "1.0.0";

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resources") opts.resources = argv[++i];
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--dialect") opts.dialect = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--force-close") opts.forceClose = true;
    else if (a === "--no-watch") opts.noWatch = true;
    else if (a === "--no-skill") opts.noSkill = true;
    else if (a === "--quiet" || a === "-q") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--check-only") opts.checkOnly = true;
    else if (a === "--version" || a === "-V") opts.version = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  return { opts, cmd: rest[0] || null };
}

function mustNode18() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) throw new Error(`需要 Node.js >= 18（当前 ${process.versions.node}），CLI 层使用内置 fetch`);
}

const FEATURE_IDS = FEATURE_ORDER.join("|");
const HELP = `zcode-suite v${VERSION} — ZCode 桌面版统一插件（model-hub 模型拉取 + zcode+ 提示词增强）

用法: zcode-suite <命令> [选项]

命令:
  install     一键注入两个特性（一次备份、一次重打包）；默认注册自动修复触发器
              --only ${FEATURE_IDS}   只安装其中一个特性（保留已注入的另一个）
  restore     还原基线 app.asar（默认为官方原版，两个特性一并移除）
  remove      卸载单个特性并保留另一个: remove --only <feature>
  status      三层状态一览（CLI 层 / 注入层 / 触发器）
  doctor      深度只读体检，失败时生成兼容性报告
  ensure      一次性自愈检查（触发器内部调用；快路径仅一次 stat）
  sync        用户空间模型同步（不修改 app.asar，更新免疫）
  watch       仅注册自动修复触发器
  unwatch     卸载自动修复触发器

选项:
  --resources <dir>   显式指定 ZCode 的 resources 目录
  --only <feature>    install/remove 的目标特性（${FEATURE_IDS}）
  --provider <id>     sync 目标供应商（id/名称）；--list 先列出
  --dialect <name>    openai | anthropic | gemini（默认 auto）
  --force-close       安装/还原前强制关闭 ZCode（默认拒绝在运行时写入）
  --force             restore 时覆盖"未知状态"保护
  --no-watch          install 时跳过自动修复触发器
  --no-skill          install 时跳过 skill/command 部署
  --quiet             ensure 静默模式（触发器用）
  --check-only        ensure 只诊断不修复
  --json              status/sync 输出 JSON

示例:
  zcode-suite install                 # 一键安装两个特性
  zcode-suite install --only zcodeplus
  zcode-suite remove --only modelhub
  zcode-suite sync --list
  zcode-suite status
`;

async function cmdInstall(opts) {
  const { install } = await import("../src/patch/apply.mjs");
  const res = await install({
    resourcesOverride: opts.resources,
    forceClose: opts.forceClose,
    only: opts.only || null,
  });
  if (res.noop) {
    console.log(`[i] ${res.note}`);
  } else {
    console.log(`[√] 注入完成 (features: ${res.features.join(", ")}; patch targets: main/preload/renderer)`);
    console.log(`    基线备份: ${res.backup}（来源: ${res.baselineSource}，全程仅此一份）`);
  }
  if (!opts.noSkill) {
    const { deploySkill } = await import("../src/deploy-skill.mjs");
    for (const f of deploySkill()) console.log(`    用户空间已部署: ${f}`);
  }
  if (!opts.noWatch) {
    try {
      const { watch } = await import("../src/repair/triggers.mjs");
      const w = watch();
      console.log(`    自动修复触发器已注册: ${JSON.stringify(w.trigger ?? w)}`);
    } catch (e) {
      console.log(`    [!] 自动修复触发器注册失败（不影响其他层）: ${e.message}`);
    }
  }
  if (!res.noop) console.log(`    ${res.note}`);
}

async function cmdRestore(opts) {
  const { restore } = await import("../src/patch/apply.mjs");
  const res = await restore({ resourcesOverride: opts.resources, forceClose: opts.forceClose, force: opts.force });
  console.log(`[√] ${res.note}`);
}

async function cmdRemove(opts) {
  if (!opts.only) throw new Error("remove 需要 --only modelhub|zcodeplus");
  const { removeFeature } = await import("../src/patch/apply.mjs");
  const res = await removeFeature({ only: opts.only, resourcesOverride: opts.resources, forceClose: opts.forceClose });
  console.log(`[√] ${res.note}`);
}

async function cmdEnsure(opts) {
  const { isZcodeRunning } = await import("../src/core/platform.mjs");
  const disc = findZcodeInstall(opts.resources);
  const ctx = {
    asarPath: disc && disc.kind === "app" ? disc.asarPath : "/nonexistent/app.asar",
    isRunning: () => isZcodeRunning(),
    waitStableMs: 1500,
    allowPatch: !opts.checkOnly,
    quiet: opts.quiet,
  };
  const { runEnsure } = await import("../src/repair/ensure.mjs");
  const r = await runEnsure(ctx);
  if (opts.quiet) {
    if (["ok", "repatched", "ok-recovered"].includes(r.action)) process.exit(0);
    if (["deferred-running", "update-in-progress"].includes(r.action)) process.exit(0); // retried later
    process.exit(3); // failed/incompatible/no-app — visible in trigger logs
  }
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else console.log(`[${r.action}]${r.error ? " " + r.error : ""}${r.detail ? " " + JSON.stringify(r.detail) : ""}`);
}

async function cmdSync(opts) {
  mustNode18();
  const { readConfig, listProviders, writeConfigAtomic, syncProvider } = await import("../src/config.mjs");
  const cfgPath = zcodeProviderConfigPath();
  const cfg = readConfig(cfgPath);
  if (!cfg) {
    console.error(`[x] 未找到 ${cfgPath}。请先在 ZCode 里添加自定义供应商。`);
    process.exit(1);
  }
  const providers = listProviders(cfg);
  if (opts.list || (opts.json && !opts.provider)) {
    if (opts.json) console.log(JSON.stringify(providers.map((p) => ({ id: p.id, kind: p.kind, baseURL: p.baseURL, models: Object.keys(p.models).length })), null, 2));
    else {
      console.log("已配置的自定义供应商:");
      for (const p of providers) {
        console.log(`  [${p.key}] ${p.id}  kind=${p.kind}  baseURL=${p.baseURL || "-"}  models=${Object.keys(p.models).length}`);
      }
      if (!providers.length) console.log("  （空）");
    }
    return;
  }
  if (!providers.length) {
    console.error("[x] 配置中没有任何自定义供应商。");
    process.exit(1);
  }

  let targets;
  if (opts.provider) {
    const want = String(opts.provider).toLowerCase();
    targets = providers.filter((p) => String(p.id).toLowerCase().includes(want) || String(p.name).toLowerCase().includes(want) || String(p.baseURL || "").toLowerCase().includes(want));
    if (!targets.length) {
      console.error(`[x] 找不到匹配 "${opts.provider}" 的供应商。用 sync --list 查看。`);
      process.exit(1);
    }
  } else if (opts.all) {
    targets = providers;
  } else if (process.stdin.isTTY) {
    console.log("选择要同步的供应商:");
    providers.forEach((p, i) => console.log(`  ${i + 1}. ${p.id}  ${p.baseURL || "-"}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((r) => rl.question("编号（多个用逗号分隔，回车=全部）: ", r));
    rl.close();
    const picks = ans.trim() ? ans.split(",").map((s) => parseInt(s.trim(), 10) - 1) : providers.map((_, i) => i);
    targets = picks.map((i) => providers[i]).filter(Boolean);
    if (!targets.length) return console.log("未选择任何供应商。");
  } else {
    console.error("[x] 非交互环境请用 --provider <id> 或 --all。");
    process.exit(1);
  }

  for (const p of targets) {
    process.stdout.write(`→ ${p.id} (${p.baseURL}) ... `);
    const r = await syncProvider(cfg, p, { dialect: opts.dialect });
    if (!r.ok) {
      console.log("失败");
      console.error(`   ${r.error}`);
      continue;
    }
    writeConfigAtomic(cfg, cfgPath);
    console.log(`ok: 共 ${r.total} 个模型，新增 ${r.added.length}（方言 ${r.dialect}）`);
    if (opts.json) console.log(JSON.stringify({ provider: p.id, total: r.total, added: r.added, models: r.models }, null, 2));
  }
  console.log("提示: 打开 ZCode 模型选择器即可看到新模型（外部写入实时生效）。");
}

function featureStateLine(id, insp) {
  const f = FEATURES[id];
  if (!insp.found) return `${f.label}: 未找到 ZCode 安装`;
  if (insp.kind === "appimage") return `${f.label}: AppImage（不支持注入）`;
  if (!insp.layoutOk) return `${f.label}: 布局异常（${insp.layoutError || "?"}）`;
  const m = insp.manifest;
  if (insp.present[id]) return `${f.label}: 在位`;
  if (m && m.features && m.features[id]) return `${f.label}: 丢失（ZCode 更新过？运行 ensure 自动修复）`;
  return `${f.label}: 未安装`;
}

async function cmdStatus(opts) {
  const { inspectInjection } = await import("../src/patch/apply.mjs");
  const { watcherActive } = await import("../src/repair/triggers.mjs");
  const { readPending } = await import("../src/core/manifest.mjs");
  const insp = await inspectInjection({ resourcesOverride: opts.resources });
  const lines = [];
  lines.push(`平台: ${platform}   Node: ${process.versions.node}`);
  // layer 1
  let cfgOk = false;
  let providerCount = 0;
  try {
    const { readConfig, listProviders } = await import("../src/config.mjs");
    const cfg = readConfig(zcodeProviderConfigPath());
    cfgOk = !!cfg;
    providerCount = cfg ? listProviders(cfg).length : 0;
  } catch {}
  lines.push(`层1 CLI/技能（更新免疫）: 配置${cfgOk ? "可读" : "不可读/缺失"}，供应商 ${providerCount} 个，命令: sync / 技能 model-hub`);
  // layer 2
  if (!insp.found) lines.push("层2 注入: 未找到 ZCode 安装");
  else if (insp.kind === "appimage") lines.push("层2 注入: AppImage（不支持注入）");
  else {
    for (const id of FEATURE_ORDER) lines.push(`层2 注入 — ${featureStateLine(id, insp)}`);
    const m = insp.manifest;
    if (m) {
      lines.push(`   记录: patchVersion=${m.patchVersion} baseline=${m.baseline ? m.baseline.source + (m.baseline.clean ? "/clean" : "/adopted") : "?"} installed=${m.installedAt}`);
    }
    if (insp.foreign.length) lines.push(`   检测到其他补丁: ${insp.foreign.join("、")}`);
  }
  // layer 3
  const pend = readPending();
  lines.push(`层3 自动修复: 触发器${watcherActive() ? "已注册" : "未注册"}${pend ? `；待处理: ${pend.reason} (${pend.at})` : ""}`);
  console.log(lines.join("\n"));
  if (opts.json) console.log(JSON.stringify({ insp, pending: pend, watcher: watcherActive() }, null, 2));
}

async function cmdDoctor(opts) {
  const findings = [];
  const disc = findZcodeInstall(opts.resources);
  findings.push(["app", disc ? (disc.kind === "appimage" ? "appimage" : "found") : "missing"]);
  if (disc && disc.kind === "app") {
    const { inspectInjection } = await import("../src/patch/apply.mjs");
    const insp = inspectInjection({ resourcesOverride: opts.resources });
    findings.push(["asar", insp.hash ? insp.hash.slice(0, 12) : "unreadable"]);
    findings.push(["layout", insp.layoutOk ? "ok" : `error: ${insp.layoutError}`]);
    if (insp.layoutOk) {
      for (const id of FEATURE_ORDER) {
        findings.push([`sentinel:${id}`, insp.present[id] ? "present" : "absent"]);
      }
    }
    if (insp.foreign.length) findings.push(["foreign-patches", insp.foreign.join(",")]);
    if (process.platform === "darwin") {
      try {
        const plist = path.join(disc.appBaseDir, "Contents", "Info.plist");
        if (fs.existsSync(plist)) {
          const { spawnSync } = await import("node:child_process");
          const out = spawnSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "raw", "-o", "-", plist], { encoding: "utf8" });
          findings.push(["asar-integrity", out.status === 0 ? "ENABLED (注入层将不可用)" : "off"]);
        }
      } catch {}
    }
  }
  const { watcherActive } = await import("../src/repair/triggers.mjs");
  findings.push(["watcher", watcherActive() ? "registered" : "not-registered"]);
  const { readPending } = await import("../src/core/manifest.mjs");
  const pend = readPending();
  findings.push(["pending", pend ? `${pend.reason} @ ${pend.at}` : "none"]);
  try {
    mustNode18();
    findings.push(["node", process.versions.node]);
  } catch {}
  for (const [k, v] of findings) console.log(`${k.padEnd(20)} ${v}`);
  const bad = findings.find(([k, v]) => String(v).startsWith("error") || (k === "pending" && v !== "none"));
  if (bad && !opts.quiet) {
    const report = { at: new Date().toISOString(), platform: process.platform, findings };
    const dir = path.join(process.env.ZCODE_SUITE_STATE_DIR || path.join(process.env.HOME || process.env.USERPROFILE || "", ".zcode", "zcode-suite"));
    fs.mkdirSync(dir, { recursive: true });
    const rp = path.join(dir, "doctor-report.json");
    fs.writeFileSync(rp, JSON.stringify(report, null, 2));
    console.log(`\n[i] 检测到异常，已生成兼容性报告: ${rp}\n    （可携带该文件提交 issue）`);
  }
}

async function cmdWatch(opts) {
  const { watch } = await import("../src/repair/triggers.mjs");
  const r = watch();
  console.log(`[√] 自动修复触发器已注册 (${r.platform}): ${JSON.stringify(r.trigger ?? r)}`);
}

async function cmdUnwatch(opts) {
  const { unwatch } = await import("../src/repair/triggers.mjs");
  const { clearPending } = await import("../src/core/manifest.mjs");
  const r = unwatch();
  clearPending();
  console.log(`[√] 已卸载触发器 (${r.platform})${r.removed ? ": " + JSON.stringify(r.removed) : ""}`);
}

async function main() {
  const { opts, cmd } = parseArgs(process.argv.slice(2));
  if (opts.version) return console.log(VERSION);
  if (opts.help || !cmd) return console.log(HELP);
  try {
    if (cmd === "install") await cmdInstall(opts);
    else if (cmd === "restore") await cmdRestore(opts);
    else if (cmd === "remove") await cmdRemove(opts);
    else if (cmd === "ensure") await cmdEnsure(opts);
    else if (cmd === "sync") await cmdSync(opts);
    else if (cmd === "status") await cmdStatus(opts);
    else if (cmd === "doctor") await cmdDoctor(opts);
    else if (cmd === "watch") await cmdWatch(opts);
    else if (cmd === "unwatch") await cmdUnwatch(opts);
    else {
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(2);
  }
}

main();
