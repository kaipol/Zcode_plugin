// `remove --only` uninstalls one feature and keeps the other; removing the
// last one falls back to restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateState, makeFixture, entryText, targetsOf, sha256File } from "./helpers.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const { install, removeFeature, restore } = await import("../src/patch/apply.mjs");
const { sentinelsPresent } = await import("../src/patch/discover-targets.mjs");

const notRunning = () => false;

test("remove --only keeps the other feature intact", async () => {
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });

  const res = await removeFeature({ only: "modelhub", resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.ok, true);
  const targets = targetsOf(fx.asarPath);
  assert.deepEqual(sentinelsPresent(fx.asarPath, targets), { modelhub: false, zcodeplus: true });
  assert.ok(!entryText(fx.asarPath, targets.rendererHtml).includes("zcode-model-hub.js"));
  assert.equal(entryText(fx.asarPath, targets.rendererScripts.modelhub), null, "modelhub renderer entry must be gone");
  assert.ok(entryText(fx.asarPath, targets.rendererScripts.zcodeplus).includes("__zcodePlusControllerVersion"));
  assert.ok(entryText(fx.asarPath, targets.main).includes("zcodeplus:request"));
  assert.ok(!entryText(fx.asarPath, targets.main).includes("modelhub:read-config"));

  // removing the last remaining feature falls back to a full restore
  const res2 = await removeFeature({ only: "zcodeplus", resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res2.ok, true);
  assert.deepEqual(sentinelsPresent(fx.asarPath, targetsOf(fx.asarPath)), { modelhub: false, zcodeplus: false });
  assert.equal(sha256File(fx.asarPath), fx.officialHash);
});
