// Shared test helpers: a synthetic official app.asar fixture + throwaway
// state dirs wired through the same env overrides the tools honor.
// Nothing here touches a real ZCode installation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packDir, readEntryText, listFiles } from "../src/core/surgical-asar.mjs";
import { sha256File } from "../src/core/verify.mjs";
import { discoverTargets } from "../src/patch/discover-targets.mjs";

const OFFICIAL_MAIN = '// synthetic app main v1\nconsole.log("app main");\n';
const OFFICIAL_PRELOAD = '// synthetic app preload v1\nconsole.log("app preload");\n';
const OFFICIAL_HTML = [
  "<!doctype html>",
  "<html>",
  "  <body>",
  '    <div id="app"></div>',
  "  </body>",
  "</html>",
  "",
].join("\n");

// Redirect every state dir (suite + both legacy plugins) into one tmp root.
// Call once per test file, before touching any suite function. The tmp root
// is removed when the test process exits.
export function isolateState() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-suite-test-"));
  process.on("exit", () => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });
  process.env.ZCODE_SUITE_STATE_DIR = path.join(tmpRoot, "state");
  process.env.ZCODE_MODEL_HUB_STATE_DIR = path.join(tmpRoot, "legacy-model-hub");
  process.env.ZCODE_PLUS_ASAR_STATE_DIR = path.join(tmpRoot, "legacy-zcode-plus");
  return tmpRoot;
}

// Build a synthetic official ZCode resources dir + app.asar fixture.
export function makeFixture(tmpRoot) {
  const srcDir = path.join(tmpRoot, "official-src");
  fs.mkdirSync(path.join(srcDir, "out", "main"), { recursive: true });
  fs.mkdirSync(path.join(srcDir, "out", "preload"), { recursive: true });
  fs.mkdirSync(path.join(srcDir, "out", "renderer"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "out", "main", "index.js"), OFFICIAL_MAIN);
  fs.writeFileSync(path.join(srcDir, "out", "preload", "index.cjs"), OFFICIAL_PRELOAD);
  fs.writeFileSync(path.join(srcDir, "out", "renderer", "index.html"), OFFICIAL_HTML);

  const resourcesDir = path.join(tmpRoot, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  const asarPath = path.join(resourcesDir, "app.asar");
  packDir(srcDir, asarPath);
  const officialHash = sha256File(asarPath);
  return { srcDir, resourcesDir, asarPath, officialHash, officialSrc: srcDir };
}

// Reset the live asar back to the official build (simulates "ZCode updated
// itself and wiped all injections" or "fresh official install").
export function resetOfficial(asarPath, officialSrc) {
  fs.rmSync(asarPath, { force: true });
  packDir(officialSrc, asarPath);
}

export function targetsOf(asarPath) {
  return discoverTargets(asarPath);
}

export function entryText(asarPath, rel) {
  return readEntryText(asarPath, rel);
}

export function backupCount(stateDirOverride) {
  const dir = path.join(stateDirOverride || process.env.ZCODE_SUITE_STATE_DIR, "backups");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
}

export { listFiles, sha256File };
