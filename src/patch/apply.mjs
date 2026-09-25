// Unified install / restore / remove for both features over ONE baseline
// chain. The baseline is the archive every repack starts from (usually the
// pristine official build; migration can adopt a standalone plugin's backup).
// Reading entries from the baseline — never from the live asar — makes every
// install deterministic: repeated, partial and migrated installs all converge
// to the same bytes. Every step fails loudly and leaves the destination
// untouched on any surprise: foreign patches, missing anchors, running app,
// asar-integrity fuses, verify mismatches.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  FEATURES,
  FEATURE_ORDER,
  ZCODEPLUS_RENDERER_VERSION,
  canonicalFeatures,
} from "../core/features.mjs";
import {
  PATCH_VERSION,
  loadManifest,
  saveManifest,
  clearPending,
  backupPathFor,
  pruneBackups,
  resolveBaseline,
} from "../core/manifest.mjs";
import { discoverTargets, sentinelsPresent, detectForeignPatches } from "./discover-targets.mjs";
import { patchEntries, readEntryText } from "../core/surgical-asar.mjs";
import { sha256File, sha256Buf, verifyPatchedArchive, atomicCopyFile } from "../core/verify.mjs";
import { findZcodeInstall, isZcodeRunning, forceCloseZcode } from "../core/platform.mjs";
import { payloadText } from "../features/payloads.mjs";
import { adaptInjectSource } from "../features/zcodeplus/adapt.mjs";

// macOS: ElectronAsarIntegrity (if configured) makes any patched asar refuse
// to load. Detect it in Info.plist up front rather than bricking the app.
function checkAsarIntegrityFuse(appBaseDir) {
  if (process.platform !== "darwin") return null;
  const plist = path.join(appBaseDir, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return null;
  try {
    const out = spawnSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "raw", "-o", "-", plist], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (out.status === 0 && (out.stdout || "").trim().length > 0) {
      throw new Error(
        "ZCode 启用了 ElectronAsarIntegrity（app.asar 完整性校验），注入层不可用。CLI/skill 层不受影响。",
      );
    }
  } catch (e) {
    if (String(e.message).startsWith("ZCode 启用了")) throw e;
  }
  return null;
}

function insertBeforeLastBody(html, tag) {
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) throw new Error("renderer html has no </body>");
  return html.slice(0, idx) + "  " + tag + "\n  " + html.slice(idx);
}

function rendererPayloadFor(id) {
  const f = FEATURES[id];
  if (f.rendererPayload) return payloadText(f.rendererPayload);
  return adaptInjectSource(payloadText("zcodeplus/inject.js"), ZCODEPLUS_RENDERER_VERSION);
}

// Build the patch map against the baseline archive. Features whose sentinel
// already lives inside the baseline (only possible for an adopted baseline)
// are not re-appended — their blocks and script tags are already in place.
function buildPatchMap(baselineAsar, targets, wanted, baselineSentinels) {
  const mainTxt = readEntryText(baselineAsar, targets.main);
  const preloadTxt = readEntryText(baselineAsar, targets.preload);
  const htmlTxt = readEntryText(baselineAsar, targets.rendererHtml);
  if (mainTxt == null || preloadTxt == null || htmlTxt == null)
    throw new Error("目标条目读取失败（可能为 unpacked 条目），ZCode 版本不兼容");

  let mainPatched = mainTxt;
  let preloadPatched = preloadTxt;
  let htmlPatched = htmlTxt;
  const patchMap = {};
  for (const id of wanted) {
    if (baselineSentinels[id]) continue;
    const f = FEATURES[id];
    mainPatched += "\n" + payloadText(f.mainPayload);
    preloadPatched += "\n" + payloadText(f.preloadPayload);
    htmlPatched = insertBeforeLastBody(
      htmlPatched,
      `<script src="./${f.rendererScript}" defer></script><!-- ${f.sentinel} -->`,
    );
    patchMap[targets.rendererScripts[id]] = Buffer.from(rendererPayloadFor(id), "utf8");
  }
  patchMap[targets.main] = Buffer.from(mainPatched, "utf8");
  patchMap[targets.preload] = Buffer.from(preloadPatched, "utf8");
  patchMap[targets.rendererHtml] = Buffer.from(htmlPatched, "utf8");
  return patchMap;
}

// Shared tail of install/remove: repack from the baseline, verify, atomically
// replace the live archive, record the unified manifest.
function repackAndRecord({ disc, targets, wanted, now }) {
  const { resourcesDir, asarPath } = disc;
  const baseline = resolveBaseline(asarPath);
  const baselineSentinels = sentinelsPresent(baseline.asar, targets);

  const patchMap = buildPatchMap(baseline.asar, targets, wanted, baselineSentinels);
  const expectedHashes = {};
  for (const [rel, buf] of Object.entries(patchMap)) expectedHashes[rel] = sha256Buf(buf);

  const tmpOut = path.join(resourcesDir, "app.asar.zcode-suite-new");
  patchEntries(baseline.asar, tmpOut, patchMap);
  const expectedSize = fs.statSync(tmpOut).size;
  verifyPatchedArchive(tmpOut, expectedHashes);

  const liveTmp = asarPath + ".zcode-suite-tmp";
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
  const featuresAfter = canonicalFeatures([
    ...FEATURE_ORDER.filter((id) => baselineSentinels[id]),
    ...wanted,
  ]);
  saveManifest({
    tool: "zcode-suite",
    patchVersion: PATCH_VERSION,
    platform: process.platform,
    resourcesDir,
    asarPath,
    appBaseDir: disc.appBaseDir,
    originalHash: baseline.originalHash,
    baseline: { source: baseline.source, clean: !FEATURE_ORDER.some((id) => baselineSentinels[id]) },
    features: Object.fromEntries(
      featuresAfter.map((id) => [
        id,
        {
          sentinel: FEATURES[id].sentinel,
          rendererScript: FEATURES[id].rendererScript,
          installedAt: now,
        },
      ]),
    ),
    patchedHash,
    patchedStat: { size: st.size, mtimeMs: st.mtimeMs },
    targets,
    entryHashes: expectedHashes,
    installedAt: now,
  });
  clearPending();
  pruneBackups(2);

  return {
    ok: true,
    backup: backupPathFor(baseline.originalHash),
    baselineSource: baseline.source,
    features: featuresAfter,
  };
}

export async function install({
  resourcesOverride,
  forceClose = false,
  only = null,
  auto = false,
  _isRunning = isZcodeRunning,
  _forceCloseFn = forceCloseZcode,
} = {}) {
  // Bug guard FIRST, before any discovery: auto mode (ensure) MUST be pinned
  // to the resources dir it inspected.
  if (auto && !resourcesOverride)
    throw new Error("internal: auto repair requires an explicit resources dir");
  if (only && !FEATURES[only]) throw new Error(`unknown feature: ${only}`);

  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录，请用 --resources 显式指定 resources 路径");
  if (disc.kind === "appimage")
    throw new Error("AppImage 版本为只读镜像，注入层不支持；CLI/skill 层不受影响");
  const { asarPath } = disc;
  checkAsarIntegrityFuse(disc.appBaseDir);

  const targets = discoverTargets(asarPath);
  const foreign = detectForeignPatches(asarPath, targets);
  if (foreign.length)
    throw new Error(`检测到其他补丁已注入（${foreign.join("、")}），叠加注入有风险，已停止。请先还原官方版本。`);
  const present = sentinelsPresent(asarPath, targets);

  // Desired set: default = full suite; --only adds the requested feature to
  // whatever is already present (an --only install never removes anything).
  const wanted = only
    ? canonicalFeatures([...FEATURE_ORDER.filter((f) => present[f]), only])
    : [...FEATURE_ORDER];

  const m = loadManifest();
  // Fast no-op: live bytes are exactly the recorded patched state and already
  // cover everything wanted — a repeated one-click install costs one hash,
  // not a repack.
  if (m && m.patchedHash) {
    try {
      if (sha256File(asarPath) === m.patchedHash && wanted.every((f) => present[f])) {
        return { ok: true, noop: true, features: canonicalFeatures(Object.keys(present).filter((f) => present[f])), note: "已是目标安装状态，无需更改。" };
      }
    } catch {}
  }

  if (_isRunning()) {
    if (auto) throw new Error("deferred: zcode running");
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出 ZCode，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  const res = repackAndRecord({ disc, targets, wanted, now: new Date().toISOString() });
  return {
    ...res,
    note: "重启 ZCode（完全退出后启动）即可生效：设置页出现「⚡️ 拉取模型」，输入框旁出现 ✨ 提示词增强。",
  };
}

export async function restore({
  resourcesOverride,
  forceClose = false,
  force = false,
  auto = false,
  _isRunning = isZcodeRunning,
  _forceCloseFn = forceCloseZcode,
} = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录");
  const { asarPath } = disc;
  const m = loadManifest();
  if (!m || !m.originalHash) throw new Error("没有可用的安装记录（manifest 缺失）");

  const backup = backupPathFor(m.originalHash);
  if (!fs.existsSync(backup)) throw new Error(`找不到基线备份：${backup}`);

  const currentHash = sha256File(asarPath);
  if (currentHash === m.originalHash) return { ok: true, noop: true, note: "当前已是基线状态，无需还原。" };
  if (currentHash !== m.patchedHash && !force)
    throw new Error("当前 app.asar 既不是本套件注入的版本也不是记录中的基线（ZCode 更新过？）。用 --force 覆盖为基线，或先确认。");

  if (_isRunning()) {
    if (auto) throw new Error("deferred: zcode running");
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  atomicCopyFile(backup, asarPath, { expectSize: fs.statSync(backup).size });
  const st = fs.statSync(asarPath);
  m.restoredAt = new Date().toISOString();
  m.patchedStat = { size: st.size, mtimeMs: st.mtimeMs };
  saveManifest(m);
  clearPending();
  const baselineClean = !(m.baseline && m.baseline.clean === false);
  return {
    ok: true,
    note: baselineClean
      ? "已还原官方原版 app.asar（两个特性一并移除）。重启 ZCode 生效。"
      : "已还原到基线（该基线迁移自旧插件的部分注入态，其中的旧注入保留）。重启 ZCode 生效。",
  };
}

// Uninstall ONE feature while keeping the other: repack from the baseline
// with only the remaining feature's payloads.
export async function removeFeature({
  only,
  resourcesOverride,
  forceClose = false,
  _isRunning = isZcodeRunning,
  _forceCloseFn = forceCloseZcode,
} = {}) {
  if (!only || !FEATURES[only]) throw new Error("remove 需要 --only modelhub|zcodeplus");
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) throw new Error("未找到 ZCode 安装目录");
  if (disc.kind === "appimage") throw new Error("AppImage 版本为只读镜像，注入层不支持");
  const { asarPath } = disc;
  const m = loadManifest();
  if (!m || !m.originalHash) throw new Error("没有可用的安装记录（manifest 缺失）");

  const targets = discoverTargets(asarPath);
  const present = sentinelsPresent(asarPath, targets);
  if (!present[only]) return { ok: true, noop: true, note: `${FEATURES[only].label} 本就不在注入状态中。` };
  const remaining = FEATURE_ORDER.filter((id) => id !== only && present[id]);

  if (_isRunning()) {
    if (!forceClose) throw new Error("ZCode 正在运行。请先退出 ZCode，或使用 --force-close。");
    if (!_forceCloseFn()) throw new Error("无法退出 ZCode 进程，已放弃。");
  }

  if (!remaining.length) {
    const r = await restore({ resourcesOverride, forceClose: false, auto: false, _isRunning, _forceCloseFn });
    return { ...r, removed: [only] };
  }

  const baseline = resolveBaseline(asarPath);
  const baselineSentinels = sentinelsPresent(baseline.asar, targets);
  if (baselineSentinels[only])
    throw new Error(
      `基线备份本身包含 ${FEATURES[only].label}（迁移自旧插件且没有干净原版），无法单独移除；请先用旧版插件的 restore 取得官方原版后重装。`,
    );

  const res = repackAndRecord({ disc, targets, wanted: remaining, now: new Date().toISOString() });
  return {
    ...res,
    removed: [only],
    note: `已移除 ${FEATURES[only].label}，保留：${res.features.map((f) => FEATURES[f].label).join("、")}。重启 ZCode 生效。`,
  };
}

// read-only status for status/doctor
export function inspectInjection({ resourcesOverride } = {}) {
  const disc = findZcodeInstall(resourcesOverride);
  if (!disc) return { found: false };
  if (disc.kind === "appimage") return { found: true, kind: "appimage", note: "AppImage 只读镜像，注入层不支持" };
  const { asarPath, appBaseDir } = disc;
  const m = loadManifest();
  const out = {
    found: true,
    kind: "app",
    asarPath,
    appBaseDir,
    manifest: m,
    hash: null,
    present: {},
    layoutOk: false,
    foreign: [],
  };
  try {
    const targets = discoverTargets(asarPath);
    out.targets = targets;
    out.layoutOk = true;
    out.present = sentinelsPresent(asarPath, targets);
    out.foreign = detectForeignPatches(asarPath, targets);
  } catch (e) {
    out.layoutError = e.message;
  }
  try {
    out.hash = sha256File(asarPath);
  } catch {}
  return out;
}
