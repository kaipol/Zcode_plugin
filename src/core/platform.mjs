// Cross-platform ZCode discovery, process checks and (manual-only) process close.
// Auto-repair never uses forceClose — it defers instead.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const OS = process.platform;

export function home() {
  return os.homedir();
}

export function stateDir() {
  if (process.env.ZCODE_SUITE_STATE_DIR) return process.env.ZCODE_SUITE_STATE_DIR;
  // legacy alias: honors the pre-suite env override so old tooling and
  // verification harnesses keep working against the same layout
  if (process.env.ZCODE_MODEL_HUB_STATE_DIR) return process.env.ZCODE_MODEL_HUB_STATE_DIR;
  return path.join(home(), ".zcode", "zcode-suite");
}

export function zcodeProviderConfigPath() {
  return path.join(home(), ".zcode", "v2", "provider_config.json");
}

// Backward-compatible alias. It now resolves to provider_config.json.
export const zcodeConfigPath = zcodeProviderConfigPath;

export function appBaseCandidates() {
  if (OS === "darwin") {
    return [
      "/Applications/ZCode.app",
      path.join(home(), "Applications", "ZCode.app"),
    ];
  }
  if (OS === "win32") {
    const cands = [];
    const lad = process.env.LOCALAPPDATA;
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"];
    if (lad) cands.push(path.join(lad, "Programs", "ZCode"));
    cands.push(path.join(pf, "ZCode"));
    if (pf86) cands.push(path.join(pf86, "ZCode"));
    try {
      for (const hive of ["HKCU", "HKLM"]) {
        const out = spawnSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "ZCode", "/d"], { encoding: "utf8", timeout: 20000 });
        if (out.status === 0 && out.stdout) {
          for (const m of out.stdout.matchAll(/InstallLocation\s+REG_SZ\s+(.*)/g)) {
            const loc = m[1].trim();
            if (loc) cands.push(loc);
          }
          // ZCode's installer does not write InstallLocation — derive the dir
          // from UninstallString / DisplayIcon instead.
          for (const m of out.stdout.matchAll(/(?:UninstallString|DisplayIcon)\s+REG_SZ\s+(.*)/g)) {
            const raw = m[1].trim();
            const exe = /^"([^"]+)"/.exec(raw)?.[1] || raw.split(/\s+/)[0];
            if (exe) cands.push(path.dirname(exe));
          }
        }
      }
    } catch {}
    return cands;
  }
  return [
    "/opt/ZCode",
    "/usr/share/zcode",
    "/usr/lib/zcode",
    path.join(home(), ".local", "share", "ZCode"),
    path.join(home(), "Applications", "ZCode"),
  ];
}

export function findZcodeInstall(explicitResources) {
  if (explicitResources) {
    const asarPath = path.join(explicitResources, "app.asar");
    if (!fs.existsSync(asarPath)) throw new Error(`no app.asar under ${explicitResources}`);
    return { resourcesDir: explicitResources, asarPath, appBaseDir: path.dirname(explicitResources), kind: "app" };
  }
  if (OS === "linux" && process.env.APPIMAGE && /zcode/i.test(process.env.APPIMAGE)) {
    return { kind: "appimage", appimage: process.env.APPIMAGE };
  }
  const candidates = [];
  for (const base of appBaseCandidates()) {
    if (OS === "darwin") candidates.push(path.join(base, "Contents", "Resources"));
    else candidates.push(path.join(base, "resources"));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "app.asar"))) {
      return { resourcesDir: c, asarPath: path.join(c, "app.asar"), appBaseDir: path.dirname(c), kind: "app" };
    }
  }
  return null;
}

export function isZcodeRunning() {
  try {
    if (OS === "win32") {
      const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe"], { encoding: "utf8", timeout: 15000 });
      return out.status === 0 && (out.stdout || "").includes("ZCode.exe");
    }
    const name = OS === "darwin" ? "ZCode" : "zcode";
    let out = spawnSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 10000 });
    if (out.status === 0 && (out.stdout || "").trim()) return true;
    if (OS === "darwin") {
      out = spawnSync("pgrep", ["-f", "ZCode.app/Contents/MacOS"], { encoding: "utf8", timeout: 10000 });
      if (out.status === 0 && (out.stdout || "").trim()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function forceCloseZcode() {
  if (OS === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "ZCode" to quit'], { timeout: 10000 });
  }
  const name = OS === "win32" ? "ZCode.exe" : OS === "darwin" ? "ZCode" : "zcode";
  for (let i = 0; i < 10; i++) {
    if (!isZcodeRunning()) return true;
    try {
      if (OS === "win32") spawnSync("taskkill", ["/IM", name, "/F"], { timeout: 10000 });
      else spawnSync("pkill", ["-x", name], { timeout: 10000 });
    } catch {}
    const until = Date.now() + 800;
    while (Date.now() < until) {}
  }
  return !isZcodeRunning();
}

export function nodeBinPath() {
  return process.execPath;
}
