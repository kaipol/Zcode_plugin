// Unified install: both features in one pass, ONE backup, deterministic
// repack from the official baseline, and a byte-identical restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateState, makeFixture, entryText, targetsOf, backupCount, sha256File } from "./helpers.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const { install, restore, inspectInjection } = await import("../src/patch/apply.mjs");
const { sentinelsPresent } = await import("../src/patch/discover-targets.mjs");
const { loadManifest } = await import("../src/core/manifest.mjs");

const notRunning = () => false;

test("install writes all features, one backup, unified manifest", async () => {
  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.ok, true);
  assert.deepEqual(res.features, ["modelhub", "zcodeplus", "sessionrewind"]);
  // no manifests existed -> live asar adopted as baseline (it IS official)
  assert.equal(res.baselineSource, "adopted");

  const targets = targetsOf(fx.asarPath);
  const present = sentinelsPresent(fx.asarPath, targets);
  assert.deepEqual(present, { modelhub: true, zcodeplus: true, sessionrewind: true });

  const mainTxt = entryText(fx.asarPath, targets.main);
  assert.ok(mainTxt.includes("modelhub:read-config"), "modelhub main handlers missing");
  assert.ok(mainTxt.includes("zcodeplus:request"), "zcodeplus main handler missing");
  assert.ok(mainTxt.includes("sessionrewind:request"), "sessionrewind main handler missing");
  const preloadTxt = entryText(fx.asarPath, targets.preload);
  assert.ok(preloadTxt.includes("zcodeModelHub"), "modelhub preload bridge missing");
  assert.ok(preloadTxt.includes("zcodePlus"), "zcodeplus preload bridge missing");
  assert.ok(preloadTxt.includes("zcodeSessionRewind"), "sessionrewind preload bridge missing");

  const htmlTxt = entryText(fx.asarPath, targets.rendererHtml);
  assert.ok(htmlTxt.includes('src="./zcode-model-hub.js"'), "modelhub script tag missing");
  assert.ok(htmlTxt.includes('src="./zcode-plus.js"'), "zcodeplus script tag missing");
  assert.ok(htmlTxt.includes('src="./zcode-session-rewind.js"'), "sessionrewind script tag missing");

  const ui = entryText(fx.asarPath, targets.rendererScripts.modelhub);
  assert.ok(ui.includes("__ZCODE_MODEL_HUB_V1__"), "modelhub renderer payload missing");
  const zp = entryText(fx.asarPath, targets.rendererScripts.zcodeplus);
  assert.ok(zp.startsWith("globalThis.__zcodePlusControllerVersion"), "zcodeplus renderer payload missing");
  assert.ok(!zp.includes("__wbEnhance"), "zcodeplus renderer payload still references CDP binding");
  const sr = entryText(fx.asarPath, targets.rendererScripts.sessionrewind);
  assert.ok(sr.startsWith("globalThis.__zcodeSessionRewindVersion"), "sessionrewind renderer payload missing");
  assert.ok(sr.includes("__ZCODE_SESSION_REWIND_V1_UI__"), "sessionrewind renderer guard missing");

  assert.equal(backupCount(), 1, "expected exactly one backup");
  const m = loadManifest();
  assert.equal(m.tool, "zcode-suite");
  assert.deepEqual(Object.keys(m.features).sort(), ["modelhub", "sessionrewind", "zcodeplus"]);
  assert.equal(m.baseline.clean, true);
  assert.equal(m.originalHash, fx.officialHash);
});

test("repeated install is a hash fast-path no-op", async () => {
  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.noop, true);
});

test("restore returns the official bytes and clears all features", async () => {
  const res = await restore({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.ok, true);
  assert.equal(sha256File(fx.asarPath), fx.officialHash);
  const targets = targetsOf(fx.asarPath);
  assert.deepEqual(sentinelsPresent(fx.asarPath, targets), { modelhub: false, zcodeplus: false, sessionrewind: false });
  assert.equal(entryText(fx.asarPath, targets.rendererScripts.zcodeplus), null);
  assert.equal(entryText(fx.asarPath, targets.rendererScripts.sessionrewind), null);
});
