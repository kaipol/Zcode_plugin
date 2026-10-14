// Session-rewind feature (third suite feature): its payloads must be
// appended to main/preload, its renderer script registered in index.html,
// and the injected renderer must carry the version stamp + UI guard.
// All persistence is done by the ZCode runtime (/rewind cascade conversation,
// /fork) — the feature itself only reads the session DB and types commands
// into the composer, so these payload-shape assertions are the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateState, makeFixture, entryText, targetsOf } from "./helpers.mjs";
import { payloadText } from "../src/features/payloads.mjs";
import { sentinelsPresent } from "../src/patch/discover-targets.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const { install, removeFeature } = await import("../src/patch/apply.mjs");

const notRunning = () => false;

test("sessionrewind payloads are self-consistent", () => {
  const main = payloadText("sessionrewind/main-handlers.js");
  // sentinel guard + only the expected IPC namespace
  assert.ok(main.includes("__ZCODE_SESSION_REWIND_V1_MAIN__"));
  assert.ok(main.includes('"sessionrewind:request"'));
  assert.ok(main.includes('"listTurns"') && main.includes('"listSessions"') && main.includes('"insertText"'));
  // read-only DB access; never writes session.revert itself
  assert.ok(main.includes("readOnly: true"));
  assert.ok(!main.includes("set revert") && !main.includes("update session set revert"));

  const preload = payloadText("sessionrewind/preload-bridge.cjs");
  assert.ok(preload.includes("__ZCODE_SESSION_REWIND_V1_PRELOAD__"));
  assert.ok(preload.includes('exposeInMainWorld("zcodeSessionRewind"'));

  const ui = payloadText("sessionrewind/ui/zcode-session-rewind.js");
  assert.ok(ui.includes("__ZCODE_SESSION_REWIND_V1_UI__"));
  assert.ok(ui.includes("__zcodeSessionRewindVersion"));
  // drives the runtime's native, ungated slash commands
  assert.ok(ui.includes("`/rewind cascade conversation ${messageId}`"));
  assert.ok(ui.includes('"/fork"'));
});

test("install wires sessionrewind into every layer, remove strips only it", async () => {
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  const targets = targetsOf(fx.asarPath);
  assert.deepEqual(sentinelsPresent(fx.asarPath, targets), { modelhub: true, zcodeplus: true, sessionrewind: true });

  const mainTxt = entryText(fx.asarPath, targets.main);
  assert.ok(mainTxt.includes("sessionrewind:request"), "sessionrewind handler missing in main");
  assert.equal(
    mainTxt.split('register("sessionrewind:request"').length - 1,
    1,
    "sessionrewind handler must be appended exactly once",
  );
  assert.ok(entryText(fx.asarPath, targets.preload).includes("zcodeSessionRewind"));
  assert.ok(entryText(fx.asarPath, targets.rendererHtml).includes('src="./zcode-session-rewind.js"'));

  const sr = entryText(fx.asarPath, targets.rendererScripts.sessionrewind);
  assert.ok(sr.startsWith("globalThis.__zcodeSessionRewindVersion"), "version stamp must lead the payload");
  assert.ok(sr.includes("__ZCODE_SESSION_REWIND_V1_UI__"));

  const res = await removeFeature({ only: "sessionrewind", resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(res.ok, true);
  const t2 = targetsOf(fx.asarPath);
  assert.deepEqual(sentinelsPresent(fx.asarPath, t2), { modelhub: true, zcodeplus: true, sessionrewind: false });
  assert.equal(entryText(fx.asarPath, t2.rendererScripts.sessionrewind), null);
  assert.ok(!entryText(fx.asarPath, t2.rendererHtml).includes("zcode-session-rewind.js"));
  assert.ok(!entryText(fx.asarPath, t2.main).includes("sessionrewind:request"));
  // the other two features survive untouched
  assert.ok(entryText(fx.asarPath, t2.main).includes("zcodeplus:request"));
  assert.ok(entryText(fx.asarPath, t2.main).includes("modelhub:read-config"));
});

test("a payload-source change forces a repack instead of a false no-op", async () => {
  const { install } = await import("../src/patch/apply.mjs");
  const { loadManifest } = await import("../src/core/manifest.mjs");
  const { payloadText } = await import("../src/features/payloads.mjs");

  // clean official baseline for this file's own fixture state
  const first = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.ok(first.ok);
  const m1 = loadManifest();
  assert.ok(m1.payloadFingerprint, "manifest must record a payload fingerprint");
  const hashAfterFirst = m1.patchedHash;

  // identical sources -> fast-path no-op
  const again = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(again.noop, true, "identical sources stay a no-op");

  // simulate a payload fix by mutating the on-disk source that payloadText reads
  const fsMod = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const srcPath = fileURLToPath(new URL("../src/features/sessionrewind/ui/zcode-session-rewind.js", import.meta.url));
  const original = fsMod.default.readFileSync(srcPath, "utf8");
  try {
    fsMod.default.writeFileSync(srcPath, original.replace("__ZCODE_SESSION_REWIND_V1_UI__", "__ZCODE_SESSION_REWIND_V1_UI__ /* patched */"));
    const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
    assert.equal(res.noop, undefined, "changed payload source must NOT take the no-op fast path");
    assert.equal(res.ok, true);
    const m2 = loadManifest();
    assert.notEqual(m2.patchedHash, hashAfterFirst, "live archive must have been repacked");
    assert.notEqual(m2.payloadFingerprint, m1.payloadFingerprint, "fingerprint must change with the source");
    assert.ok(entryText(fx.asarPath, targetsOf(fx.asarPath).rendererScripts.sessionrewind).includes("/* patched */"));
  } finally {
    fsMod.default.writeFileSync(srcPath, original);
  }
});