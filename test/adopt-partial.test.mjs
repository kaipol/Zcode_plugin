// Adopted-baseline handling: an asar patched by a standalone plugin with NO
// recoverable manifest is adopted as-is; the suite adds only what's missing
// and refuses to strip a feature that has no clean official copy to fall
// back on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isolateState, makeFixture, entryText, targetsOf, backupCount } from "./helpers.mjs";
import { patchEntries, readEntryText } from "../src/core/surgical-asar.mjs";
import { discoverTargets, sentinelsPresent } from "../src/patch/discover-targets.mjs";
import { payloadText } from "../src/features/payloads.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const { install, removeFeature } = await import("../src/patch/apply.mjs");
const { loadManifest } = await import("../src/core/manifest.mjs");

const notRunning = () => false;

// Simulate a REAL standalone model-hub install (same mechanism, same
// payloads) whose manifest was later lost: the live asar carries the full
// modelhub payload but no manifests exist anywhere.
function craftLegacyPatchedLive() {
  const targets = discoverTargets(fx.asarPath);
  const mainTxt = readEntryText(fx.asarPath, targets.main);
  const preloadTxt = readEntryText(fx.asarPath, targets.preload);
  const htmlTxt = readEntryText(fx.asarPath, targets.rendererHtml);
  const tag = `<script src="./zcode-model-hub.js" defer></script><!-- __ZCODE_MODEL_HUB_V1__ -->`;
  const idx = htmlTxt.lastIndexOf("</body>");
  const htmlPatched = htmlTxt.slice(0, idx) + "  " + tag + "\n  " + htmlTxt.slice(idx);
  const tmpOut = fx.asarPath + ".legacy-tmp";
  patchEntries(fx.asarPath, tmpOut, {
    [targets.main]: Buffer.from(mainTxt + "\n" + payloadText("modelhub/main-handlers.js"), "utf8"),
    [targets.preload]: Buffer.from(preloadTxt + "\n" + payloadText("modelhub/preload-bridge.cjs"), "utf8"),
    [targets.rendererHtml]: Buffer.from(htmlPatched, "utf8"),
    [targets.rendererScripts.modelhub]: Buffer.from(payloadText("modelhub/ui/zcode-model-hub.js"), "utf8"),
  });
  fs.renameSync(tmpOut, fx.asarPath);
}

test("suite adopts a manifest-less patched asar and completes the install", async () => {
  craftLegacyPatchedLive();
  assert.deepEqual(sentinelsPresent(fx.asarPath, discoverTargets(fx.asarPath)), {
    modelhub: true,
    zcodeplus: false,
  });

  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.baselineSource, "adopted");
  assert.deepEqual(res.features, ["modelhub", "zcodeplus"]);
  assert.equal(loadManifest().baseline.clean, false, "adopted baseline is not a clean official build");

  const targets = targetsOf(fx.asarPath);
  const mainTxt = entryText(fx.asarPath, targets.main);
  assert.ok(mainTxt.includes("modelhub:read-config"), "adopted modelhub payload must survive");
  assert.ok(mainTxt.includes("zcodeplus:request"), "zcodeplus payload added");
  assert.equal(
    mainTxt.split('register("modelhub:read-config"').length - 1,
    1,
    "modelhub handlers must NOT be appended twice",
  );
  assert.ok(entryText(fx.asarPath, targets.rendererHtml).includes("zcode-plus.js"));
  assert.ok(entryText(fx.asarPath, targets.rendererHtml).includes("zcode-model-hub.js"));
  assert.equal(backupCount(), 1);
});

test("remove refuses to strip a feature that lives inside the adopted baseline", async () => {
  await assert.rejects(
    removeFeature({ only: "modelhub", resourcesOverride: fx.resourcesDir, _isRunning: notRunning }),
    /基线/,
  );
});
