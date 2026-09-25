// Syntax-check every JS payload + module with the current Node binary.
// The injected payloads must parse as a Script (main) / CJS (preload) /
// classic script in the renderer, so plain `node --check` is the right gate.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [
  "bin/zcode-suite.mjs",
  "src/core/platform.mjs",
  "src/core/features.mjs",
  "src/core/manifest.mjs",
  "src/core/surgical-asar.mjs",
  "src/core/verify.mjs",
  "src/config.mjs",
  "src/deploy-skill.mjs",
  "src/providers/index.mjs",
  "src/patch/discover-targets.mjs",
  "src/patch/apply.mjs",
  "src/repair/ensure.mjs",
  "src/repair/triggers.mjs",
  "src/features/payloads.mjs",
  "src/features/payloads.embedded.mjs",
  "src/features/zcodeplus/adapt.mjs",
  "src/features/modelhub/main-handlers.js",
  "src/features/modelhub/preload-bridge.cjs",
  "src/features/modelhub/ui/zcode-model-hub.js",
  "src/features/zcodeplus/main-handlers.js",
  "src/features/zcodeplus/preload-bridge.cjs",
  "src/features/zcodeplus/inject.js",
  "scripts/verify-smart-config.mjs",
  "scripts/build.mjs",
];

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}\n${r.stderr}`);
  } else {
    console.log(`ok   ${f}`);
  }
}
process.exit(failed ? 1 : 0);
