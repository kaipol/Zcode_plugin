// Build the single-file distribution: dist/zcode-suite.mjs.
//
// The artifact is a self-extracting installer — the entire runtime file tree
// (bin/ + src/, payloads and templates included) is embedded as text and
// extracted to ~/.zcode/zcode-suite/app on first run, then the real CLI is
// invoked with the original arguments. This keeps the embedded code byte-
// identical to the source tree (no bundler rewrites to debug) while the
// deliverable stays ONE script file: `node zcode-suite.mjs install`.
//
//   node scripts/build.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

// Runtime tree for the self-extracting artifact: the suite's own modules and
// payloads, listed explicitly. The repo root still holds legacy pre-suite
// sources in the same directories (src/archive, src/platform.mjs,
// src/patch/manifest.mjs, src/patch/snippets, bin/zcode-model-hub.mjs);
// walking directories would embed them — enumerate instead.
const RUNTIME = [
  "bin/zcode-suite.mjs",
  "src/core/features.mjs",
  "src/core/manifest.mjs",
  "src/core/platform.mjs",
  "src/core/surgical-asar.mjs",
  "src/core/verify.mjs",
  "src/config.mjs",
  "src/deploy-skill.mjs",
  "src/features/modelhub/main-handlers.js",
  "src/features/modelhub/preload-bridge.cjs",
  "src/features/modelhub/ui/zcode-model-hub.js",
  "src/features/payloads.embedded.mjs",
  "src/features/payloads.mjs",
  "src/features/zcodeplus/adapt.mjs",
  "src/features/zcodeplus/inject.js",
  "src/features/zcodeplus/main-handlers.js",
  "src/features/zcodeplus/preload-bridge.cjs",
  "src/patch/apply.mjs",
  "src/patch/discover-targets.mjs",
  "src/providers/index.mjs",
  "src/repair/ensure.mjs",
  "src/repair/triggers.mjs",
  "src/templates/command-pull-models.md",
  "src/templates/skill-model-hub-SKILL.md",
];

function collectFiles() {
  const out = {};
  for (const rel of RUNTIME) {
    const full = path.join(root, ...rel.split("/"));
    out[rel] = fs.readFileSync(full, "utf8");
  }
  return out;
}

function extractorSource(files) {
  const head = `#!/usr/bin/env node
// zcode-suite v${version} — single-file self-extracting installer (generated).
// Usage: node zcode-suite.mjs <command> [options]   e.g.  node zcode-suite.mjs install
// Files are extracted to ~/.zcode/zcode-suite/app (override: ZCODE_SUITE_APP_DIR)
// and the unified CLI runs from there with the same arguments.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BUILD = ${JSON.stringify({ version, builtAt: new Date().toISOString() })};
const APP_DIR = process.env.ZCODE_SUITE_APP_DIR || path.join(os.homedir(), ".zcode", "zcode-suite", "app");
const FILES = ${JSON.stringify(files)};
`;
  const tail = `
function extractAll() {
  let written = 0;
  for (const [rel, content] of Object.entries(FILES)) {
    const dst = path.join(APP_DIR, ...rel.split("/"));
    try {
      if (fs.readFileSync(dst, "utf8") === content) continue;
    } catch {}
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + ".extract-tmp";
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, dst);
    written++;
  }
  fs.writeFileSync(
    path.join(APP_DIR, ".suite-build.json"),
    JSON.stringify({ ...BUILD, files: Object.keys(FILES).length, writtenAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return written;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    console.log(BUILD.version);
    return 0;
  }
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(\`zcode-suite v\${BUILD.version}（单文件自解压安装器，构建于 \${BUILD.builtAt}）

用法: node zcode-suite.mjs <命令> [选项]
命令与选项同统一 CLI（install / restore / remove / status / doctor / ensure / sync / watch / unwatch），
常用入口:  node zcode-suite.mjs install
运行时文件将解压到: \${APP_DIR}\`);
    return args.length ? 0 : 0;
  }
  const written = extractAll();
  const cli = path.join(APP_DIR, "bin", "zcode-suite.mjs");
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(\`[x] 无法运行解压后的 CLI: \${r.error.message}\`);
    return 2;
  }
  if (written > 0 && !args.includes("--quiet")) {
    console.error(\`[i] 已从单文件安装器解压 \${written} 个文件到 \${APP_DIR}\`);
  }
  return r.status ?? 1;
}

process.exit(main());
`;
  return head + tail;
}

function main() {
  const files = collectFiles();
  const count = Object.keys(files).length;
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const out = path.join(distDir, "zcode-suite.mjs");
  const src = extractorSource(files);
  const tmp = out + ".build-tmp";
  fs.writeFileSync(tmp, src, "utf8");
  fs.renameSync(tmp, out);

  // gate 1: the artifact must parse
  const chk = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
  if (chk.status !== 0) {
    console.error(`[x] dist 语法检查失败:\n${chk.stderr}`);
    process.exit(1);
  }
  // gate 2: --version must short-circuit inside the extractor
  const ver = spawnSync(process.execPath, [out, "--version"], { encoding: "utf8" });
  if (ver.status !== 0 || ver.stdout.trim() !== version) {
    console.error(`[x] dist --version 冒烟失败: status=${ver.status} stdout=${ver.stdout.trim()}`);
    process.exit(1);
  }
  // gate 3: extraction + CLI import chain in a throwaway app dir
  const smokeApp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-suite-dist-"));
  const smoke = spawnSync(process.execPath, [out, "status"], {
    encoding: "utf8",
    env: { ...process.env, ZCODE_SUITE_APP_DIR: path.join(smokeApp, "app"), ZCODE_SUITE_STATE_DIR: path.join(smokeApp, "state") },
  });
  fs.rmSync(smokeApp, { recursive: true, force: true });
  if (smoke.status !== 0) {
    console.error(`[x] dist 解压冒烟失败:\n${smoke.stdout}${smoke.stderr}`);
    process.exit(1);
  }

  const hash = crypto.createHash("sha256").update(src).digest("hex");
  console.log(`[√] dist/zcode-suite.mjs 已生成`);
  console.log(`    内嵌文件: ${count}   大小: ${(src.length / 1024).toFixed(1)} KiB`);
  console.log(`    SHA256:   ${hash}`);
  console.log(`    用法:     node dist/zcode-suite.mjs install`);
}

main();
