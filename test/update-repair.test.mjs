// Regression: after a ZCode update the live asar is the NEW official build —
// reinstalling must patch the NEW build, never resurrect the recorded old
// baseline (which downgraded the whole app; reported as "重装回到上一版本").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateState, makeFixture, entryText, targetsOf, sha256File } from "./helpers.mjs";
import { packDir } from "../src/core/surgical-asar.mjs";
import { install, restore } from "../src/patch/apply.mjs";
import { sentinelsPresent } from "../src/patch/discover-targets.mjs";
import { loadManifest } from "../src/core/manifest.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const notRunning = () => false;

test("install after a ZCode update patches the new build in place", async () => {
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  const oldOriginalHash = loadManifest().originalHash;
  const oldBackupPath = path.join(process.env.ZCODE_SUITE_STATE_DIR, "backups", oldOriginalHash, "app.asar");
  assert.equal(fs.existsSync(oldBackupPath), true, "old baseline backup exists");

  // simulate the ZCode updater: a NEW official build lands on disk
  const v2src = path.join(tmpRoot, "official-src-v2");
  fs.mkdirSync(path.join(v2src, "out", "main"), { recursive: true });
  fs.mkdirSync(path.join(v2src, "out", "preload"), { recursive: true });
  fs.mkdirSync(path.join(v2src, "out", "renderer"), { recursive: true });
  fs.writeFileSync(path.join(v2src, "out", "main", "index.js"), '// synthetic app main v2\nconsole.log("app main v2");\n');
  fs.writeFileSync(path.join(v2src, "out", "preload", "index.cjs"), '// synthetic app preload v2\nconsole.log("app preload v2");\n');
  fs.writeFileSync(path.join(v2src, "out", "renderer", "index.html"), "<!doctype html>\n<html>\n  <body>\n    <div id=\"app-v2\"></div>\n  </body>\n</html>\n");
  fs.rmSync(fx.asarPath, { force: true });
  packDir(v2src, fx.asarPath);
  const v2Hash = sha256File(fx.asarPath);
  assert.notEqual(v2Hash, oldOriginalHash, "fixture really changed");

  // reinstall after the update
  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.ok, true);
  assert.equal(res.baselineSource, "adopted", "stale baseline must not be reused after an update");

  // patched state must contain the NEW app code, not the old build
  const targets = targetsOf(fx.asarPath);
  const mainTxt = entryText(fx.asarPath, targets.main);
  assert.ok(mainTxt.includes("app main v2"), "new build content must survive the repack");
  assert.ok(!mainTxt.includes("app main v1"), "old build content must not be resurrected");
  assert.ok(mainTxt.includes("modelhub:read-config") && mainTxt.includes("zcodeplus:request"));
  assert.deepEqual(sentinelsPresent(fx.asarPath, targets), { modelhub: true, zcodeplus: true });

  // manifest now records the NEW official baseline; restore returns to it
  const m = loadManifest();
  assert.equal(m.originalHash, v2Hash);
  const r = await restore({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(r.ok, true);
  assert.equal(sha256File(fx.asarPath), v2Hash, "restore returns the NEW official build");
  assert.equal(fs.existsSync(oldBackupPath), true, "old backup kept as history");
});

test("first install on the recorded official state still reuses the verified backup", async () => {
  // reinstall while live == recorded baseline: the suite backup is the source
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.noop, true, "identical reinstall is the hash fast-path noop");
});
