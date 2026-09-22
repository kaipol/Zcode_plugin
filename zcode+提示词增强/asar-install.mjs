#!/usr/bin/env node
/*
ZCode+ asar 安装器 —— 把「CDP 常驻控制器注入」转换为「安装目录手术式改写」。

与 zcode-model-hub 同一机制：不改 ZCode 启动方式、不需要调试端口与常驻进程，
直接把 ZCode+ 的主进程服务（模型调用/凭据解析/受信输入）与页面脚本写进安装目录
的 app.asar；ZCode 正常启动即生效，页面刷新/新窗口自动带上（由 index.html 的
defer script 保证）。

- install  : 备份当前 app.asar → 注入 main/preload/renderer 三个条目 → 原子替换
- restore  : 按安装前哈希精确还原
- status   : 只读查看注入状态

与 zcode-model-hub 的共存：两者各用独立 sentinel/manifest/备份目录，按顺序叠加
（后装者的"原版"= 前者的已注入态）。ZCode 更新会清掉两者，重跑各自 install 即可。

用法:
  node asar-install.mjs install  [--resources <dir>]
  node asar-install.mjs restore  [--resources <dir>] [--force]
  node asar-install.mjs status   [--resources <dir>]
*/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  patchEntries,
  readEntryText,
  listFiles,
} from "../src/archive/surgical-asar.mjs";
import {
  sha256File,
  sha256Buf,
  verifyPatchedArchive,
  atomicCopyFile,
} from "../src/archive/verify.mjs";
import {
  findZcodeInstall,
  isZcodeRunning,
} from "../src/platform.mjs";
import { discoverTargets, detectForeignPatches } from "../src/patch/discover-targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";
const SENTINEL = "__ZCODE_PLUS_V1__";
const RENDERER_SCRIPT = "zcode-plus.js";
const STATE_DIR = process.env.ZCODE_PLUS_ASAR_STATE_DIR || path.join(os.homedir(), ".zcode", "zcode-plus");
const MANIFEST = path.join(STATE_DIR, "manifest.json");
const BACKUPS = path.join(STATE_DIR, "backups");
const EXCLUDE = /(^|\/)(node_modules|\.cache|test|tests|__tests__)(\/|$)/;

// ---- inject.js → 渲染层载荷的适配（精确锚点，歧义即失败）----
const A_START = "  // ---- 与控制器的 binding 通信 ----";
const A_END = [
  '        reject(new Error("无法联系 ZCode+ 控制器：" + String(error?.message || error)));',
  "      }",
    "    });",
  "  }",
].join("\n");
const A_REPLACEMENT = `  // ---- 与 ZCode+ 主进程服务的通信（asar 注入版：contextBridge + IPC）----
  let requestSeq = 0;
  function readWorkspacePaths() {
    // 从 localStorage 的 last-session 键提取工作区路径（主进程据此读工作区级 provider 池）
    try {
      const prefix = "zcode-v4-last-session:v1:";
      return Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        // ZCode Windows 存盘符路径、Linux 存 POSIX 绝对路径（/home/...），两种形态都放行
        .filter((p) => /^[A-Za-z]:[\\\\/]/.test(p) || p.startsWith("/"));
    } catch { return []; }
  }
  function controllerRequest(type, extra = {}, manualOverride) {
    if (!window.zcodePlus || typeof window.zcodePlus.request !== "function") {
      return Promise.reject(new Error("未检测到 ZCode+ 注入：请运行 zcode+ 安装器（node asar-install.mjs install）后重启 ZCode"));
    }
    const id = ++requestSeq;
    const s = loadSettings();
    // manualOverride：设置面板传入表单当前值（未保存即生效）；null 表示显式走自动模式
    const manual = manualOverride !== undefined ? manualOverride
      : s.mode === "manual"
        ? { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, protocol: s.protocol, omitStore: s.omitStore }
        : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("请求超过 90 秒，原文已保留")), REQUEST_TIMEOUT_MS);
      window.zcodePlus.request(JSON.stringify({ type, id, manual, thinking: s.thinking, modelLabel: readModelLabel(), workspacePaths: readWorkspacePaths(), ...extra }))
        .then((payloadJson) => {
          clearTimeout(timer);
          let data;
          try { data = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson; } catch { data = { ok: false, error: "ZCode+ 返回无效数据" }; }
          if (data && data.ok) resolve(data);
          else reject(new Error((data && data.error) || "ZCode+ 处理失败"));
        }, (error) => {
          clearTimeout(timer);
          reject(new Error("无法联系 ZCode+ 主进程服务：" + String(error?.message || error)));
        });
    });
  }`;
const C_OLD = 'typeof window.__wbEnhance === "function"';
const C_NEW = 'typeof window.zcodePlus === "object" && window.zcodePlus !== null && typeof window.zcodePlus.request === "function"';

function countOccurrences(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// 把 CDP 版 inject.js 适配为 asar 版渲染层载荷；任何锚点不匹配都硬失败（宁可拒绝安装，不写坏页面脚本）
export function adaptInjectSource(source, version) {
  let out = source;
  const startCount = countOccurrences(out, A_START);
  if (startCount !== 1) throw new Error(`inject.js 适配失败：binding 区块锚点出现 ${startCount} 次（期望 1 次），inject.js 版本可能不兼容`);
  const startIdx = out.indexOf(A_START);
  const endIdx = out.indexOf(A_END, startIdx);
  if (endIdx < 0) throw new Error("inject.js 适配失败：controllerRequest 结尾锚点未找到");
  const endAbs = endIdx + A_END.length;
  out = out.slice(0, startIdx) + A_REPLACEMENT + out.slice(endAbs);
  const cCount = countOccurrences(out, C_OLD);
  if (cCount !== 2) throw new Error(`inject.js 适配失败：受信输入通道守卫出现 ${cCount} 次（期望 2 次）`);
  out = out.split(C_OLD).join(C_NEW);
  if (out.includes("__wbEnhance")) throw new Error("inject.js 适配失败：仍残留 CDP binding 引用（__wbEnhance）");
  return `globalThis.__zcodePlusControllerVersion = ${JSON.stringify(version)};\n` + out;
}

function snippet(name) {
  return fs.readFileSync(path.join(HERE, "asar", name), "utf8");
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return null; }
}

function saveManifest(m) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), "utf8");
}

function backupPathFor(hash) {
  return path.join(BACKUPS, hash, "app.asar");
}

function ensureBackup(asarPath, hash) {
  const dst = backupPathFor(hash);
  if (fs.existsSync(dst)) {
    if (sha256File(dst) === hash) return dst;
    fs.rmSync(path.dirname(dst), { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  atomicCopyFile(asarPath, dst, { expectSize: fs.statSync(asarPath).size });
  return dst;
}

function pruneBackups(keep = 2) {
  if (!fs.existsSync(BACKUPS)) return [];
  const entries = fs.readdirSync(BACKUPS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: path.join(BACKUPS, d.name), mtime: fs.statSync(path.join(BACKUPS, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const e of entries.slice(keep)) {
    fs.rmSync(e.dir, { recursive: true, force: true });
    removed.push(path.basename(e.dir));
  }
  return removed;
}

function isOwnPatched(archive, targets) {
  for (const rel of [targets.main, targets.preload, targets.rendererHtml]) {
    const txt = readEntryText(archive, rel);
    if (txt && txt.includes(SENTINEL)) return true;
  }
  return false;
}

function patchRendererHtml(html) {
  if (html.includes(SENTINEL)) throw new Error("renderer html 已包含 ZCode+ sentinel");
  const tag = `<script src="./${RENDERER_SCRIPT}" defer></script><!-- ${SENTINEL} -->`;
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) throw new Error("renderer html 没有 </body> 锚点");
  return html.slice(0, idx) + "  " + tag + "\n  " + html.slice(idx);
}

async function install({ resourcesOverride } = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录，请用 --resources 显式指定 resources 路径");
  if (disc.kind === "appimage") throw new Error("AppImage 版本为只读镜像，不支持注入");
  const { resourcesDir, asarPath } = disc;
  // 测试专用旁路（对 app.asar 副本做回环测试时用）；正常 CLI 不应设置
  if (!process.env.ZCODE_PLUS_ASAR_ALLOW_RUNNING && isZcodeRunning()) {
    throw new Error("ZCode 正在运行。请先完全退出 ZCode 再安装。");
  }

  const targets = discoverTargets(asarPath);
  // zcode+ 必须使用自己的渲染层脚本名，绝不复用 discoverTargets 的 uiScript
  // （那是 zcode-model-hub 的 zcode-model-hub.js，直接用它会把对方的 UI 脚本覆盖掉）
  const zplusScript = targets.rendererHtml.replace(/index\.html$/, RENDERER_SCRIPT);
  if (zplusScript === targets.uiScript) throw new Error("内部错误：渲染层脚本名与 zcode-model-hub 冲突");
  if (isOwnPatched(asarPath, targets)) {
    throw new Error("检测到 ZCode+ 已注入（sentinel 存在）。如需重装请先运行 restore。");
  }
  const foreign = detectForeignPatches(asarPath, targets);
  if (foreign.length) {
    throw new Error(`检测到其他补丁已注入（${foreign.join("、")}），叠加注入有风险，已停止。`);
  }
  const coexists = (() => {
    for (const rel of [targets.main, targets.preload, targets.rendererHtml]) {
      const txt = readEntryText(asarPath, rel);
      if (txt && txt.includes("__ZCODE_MODEL_HUB_V1__")) return true;
    }
    return false;
  })();

  const mainTxt = readEntryText(asarPath, targets.main);
  const preloadTxt = readEntryText(asarPath, targets.preload);
  const htmlTxt = readEntryText(asarPath, targets.rendererHtml);
  if (mainTxt == null || preloadTxt == null || htmlTxt == null) {
    throw new Error("目标条目读取失败（可能为 unpacked 条目），ZCode 版本不兼容");
  }
  const injectSource = fs.readFileSync(path.join(HERE, "inject.js"), "utf8");
  const rendererPayload = adaptInjectSource(injectSource, `1.3.2-asar.${VERSION}`);

  const originalHash = sha256File(asarPath);
  const backup = ensureBackup(asarPath, originalHash);

  const patchMap = {
    [targets.main]: Buffer.from(mainTxt + "\n" + snippet("main-handlers.js"), "utf8"),
    [targets.preload]: Buffer.from(preloadTxt + "\n" + snippet("preload-bridge.cjs"), "utf8"),
    [targets.rendererHtml]: Buffer.from(patchRendererHtml(htmlTxt), "utf8"),
    [zplusScript]: Buffer.from(rendererPayload, "utf8"),
  };
  const expectedHashes = {};
  for (const [rel, buf] of Object.entries(patchMap)) expectedHashes[rel] = sha256Buf(buf);

  const tmpOut = path.join(resourcesDir, "app.asar.zcode-plus-new");
  patchEntries(asarPath, tmpOut, patchMap);
  const expectedSize = fs.statSync(tmpOut).size;
  verifyPatchedArchive(tmpOut, expectedHashes);

  const liveTmp = asarPath + ".zcode-plus-tmp";
  fs.rmSync(liveTmp, { force: true });
  fs.copyFileSync(tmpOut, liveTmp);
  if (fs.statSync(liveTmp).size !== expectedSize) {
    fs.rmSync(liveTmp, { force: true });
    throw new Error("live copy size mismatch - aborted, original untouched");
  }
  fs.renameSync(liveTmp, asarPath);
  fs.rmSync(tmpOut, { force: true });

  const patchedHash = sha256File(asarPath);
  const st = fs.statSync(asarPath);
  saveManifest({
    tool: "zcode-plus-asar",
    patchVersion: VERSION,
    sentinel: SENTINEL,
    platform: process.platform,
    resourcesDir,
    asarPath,
    originalHash,
    patchedHash,
    patchedStat: { size: st.size, mtimeMs: st.mtimeMs },
    targets: { ...targets, zplusScript },
    entryHashes: expectedHashes,
    rendererPayloadVersion: `1.3.2-asar.${VERSION}`,
    installedAt: new Date().toISOString(),
  });
  pruneBackups(2);
  return {
    ok: true,
    backup,
    targets,
    coexistsWithModelHub: coexists,
    note: "重启 ZCode（完全退出后启动）即可使用输入框旁的 ✨ 提示词增强按钮。",
  };
}

async function restore({ resourcesOverride, force = false } = {}) {
  const m = readManifest();
  if (!m || !m.originalHash) throw new Error("没有可用的安装记录（manifest 缺失）");
  const asarPath = m.asarPath;
  if (resourcesOverride && path.resolve(path.join(resourcesOverride, "app.asar")) !== path.resolve(String(asarPath))) {
    throw new Error(`--resources 与 manifest 记录不一致（${asarPath}）`);
  }
  // 测试专用旁路（与 install 一致）；正常 CLI 不应设置
  if (!process.env.ZCODE_PLUS_ASAR_ALLOW_RUNNING && isZcodeRunning()) {
    throw new Error("ZCode 正在运行。请先完全退出 ZCode 再还原。");
  }
  const backup = backupPathFor(m.originalHash);
  if (!fs.existsSync(backup)) throw new Error(`找不到安装前备份：${backup}`);
  const currentHash = sha256File(asarPath);
  if (currentHash === m.originalHash) return { ok: true, note: "当前已是安装前状态，无需还原。" };
  if (currentHash !== m.patchedHash && !force) {
    throw new Error("当前 app.asar 既不是 ZCode+ 已注入版本也不是记录中的安装前状态（ZCode 更新过？）。用 --force 覆盖。");
  }
  atomicCopyFile(backup, asarPath, { expectSize: fs.statSync(backup).size });
  m.restoredAt = new Date().toISOString();
  saveManifest(m);
  return { ok: true, note: "已还原 ZCode+ 注入前的 app.asar。重启 ZCode 生效。" };
}

function status({ resourcesOverride } = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  const m = readManifest();
  const lines = [];
  lines.push(`ZCode+ asar 安装器 v${VERSION}`);
  if (!disc) {
    lines.push("未找到 ZCode 安装目录");
  } else if (disc.kind === "appimage") {
    lines.push("AppImage（不支持注入）");
  } else {
    lines.push(`app.asar: ${disc.asarPath}`);
    try {
      const targets = discoverTargets(disc.asarPath);
      const present = isOwnPatched(disc.asarPath, targets);
      lines.push(`注入状态: ${present ? "已注入" : "未注入"}`);
      let modelHub = false;
      for (const rel of [targets.main, targets.preload, targets.rendererHtml]) {
        const txt = readEntryText(disc.asarPath, rel);
        if (txt && txt.includes("__ZCODE_MODEL_HUB_V1__")) { modelHub = true; break; }
      }
      lines.push(`zcode-model-hub 共存: ${modelHub ? "是" : "否"}`);
    } catch (e) {
      lines.push(`布局检查失败: ${e.message}`);
    }
  }
  lines.push(`manifest: ${m ? `installed=${m.installedAt} patched=${(m.patchedHash || "").slice(0, 12)}` : "无"}`);
  if (m) lines.push(`备份目录: ${BACKUPS}`);
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("--"));
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resources") opts.resources = argv[++i];
    else if (argv[i] === "--force") opts.force = true;
  }
  if (cmd === "install") {
    install({ resourcesOverride: opts.resources }).then((res) => {
      console.log("[√] ZCode+ 已注入 app.asar");
      console.log(`    备份: ${res.backup}`);
      console.log(`    注入目标: ${Object.keys(res.targets).join(", ")}`);
      console.log(`    与 zcode-model-hub 共存: ${res.coexistsWithModelHub ? "是" : "否"}`);
      console.log(`    ${res.note}`);
    }).catch(showError);
  } else if (cmd === "restore") {
    restore({ resourcesOverride: opts.resources, force: opts.force }).then((r) => console.log(`[√] ${r.note}`)).catch(showError);
  } else if (cmd === "status") {
    console.log(status({ resourcesOverride: opts.resources }));
  } else {
    console.log("用法: node asar-install.mjs <install|restore|status> [--resources <dir>] [--force]");
    process.exit(cmd ? 1 : 0);
  }
}
function showError(e) {
  console.error(`[x] ${e.message}`);
  process.exit(2);
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
