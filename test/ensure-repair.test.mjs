// The unified auto-repair state machine: reinstall restores BOTH features
// (or the manifest-recorded subset), the stat fast path holds afterwards,
// and running-app/update-in-progress cases defer with a pending record.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateState, makeFixture, resetOfficial, targetsOf } from "./helpers.mjs";
import { runEnsure } from "../src/repair/ensure.mjs";
import { install } from "../src/patch/apply.mjs";
import { sentinelsPresent } from "../src/patch/discover-targets.mjs";
import { readPending } from "../src/core/manifest.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const notRunning = () => false;

test("ensure repairs a wiped install back to the full suite", async () => {
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  // simulate a ZCode update: fresh official archive, injections gone
  resetOfficial(fx.asarPath, fx.officialSrc);

  const r = await runEnsure({
    asarPath: fx.asarPath,
    isRunning: notRunning,
    waitStableMs: 0,
    allowPatch: true,
  });
  assert.equal(r.action, "repatched");
  assert.deepEqual(sentinelsPresent(fx.asarPath, targetsOf(fx.asarPath)), {
    modelhub: true,
    zcodeplus: true,
  });

  const fast = await runEnsure({
    asarPath: fx.asarPath,
    isRunning: notRunning,
    waitStableMs: 0,
    allowPatch: true,
  });
  assert.equal(fast.action, "ok", "second ensure must take the stat fast path");
});

test("ensure defers while ZCode runs and records pending", async () => {
  resetOfficial(fx.asarPath, fx.officialSrc);
  const r = await runEnsure({
    asarPath: fx.asarPath,
    isRunning: () => true,
    waitStableMs: 0,
    allowPatch: true,
  });
  assert.equal(r.action, "deferred-running");
  const pending = readPending();
  assert.equal(pending.reason, "zcode-running");

  const dry = await runEnsure({
    asarPath: fx.asarPath,
    isRunning: notRunning,
    waitStableMs: 0,
    allowPatch: false,
  });
  assert.equal(dry.action, "needs-patch");
});

test("ensure repairs a single-feature install to that same feature", async () => {
  resetOfficial(fx.asarPath, fx.officialSrc);
  await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning, only: "zcodeplus" });
  resetOfficial(fx.asarPath, fx.officialSrc);

  const r = await runEnsure({
    asarPath: fx.asarPath,
    isRunning: notRunning,
    waitStableMs: 0,
    allowPatch: true,
  });
  assert.equal(r.action, "repatched");
  assert.deepEqual(sentinelsPresent(fx.asarPath, targetsOf(fx.asarPath)), {
    modelhub: false,
    zcodeplus: true,
  });
});
