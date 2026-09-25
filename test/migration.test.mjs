// Migration from the standalone plugins: their manifests + backups are
// imported (earliest installedAt wins = the true official build), backups
// dedupe into ONE chain, and the legacy tombstone state survives.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateState, makeFixture, backupCount, sha256File } from "./helpers.mjs";

const tmpRoot = isolateState();
const fx = makeFixture(tmpRoot);
const { install, restore } = await import("../src/patch/apply.mjs");
const { loadManifest } = await import("../src/core/manifest.mjs");

const notRunning = () => false;

function writeLegacyManifest(dirId, installedAt) {
  const dir = process.env[dirId];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      { tool: dirId, originalHash: fx.officialHash, asarPath: fx.asarPath, installedAt },
      null, 2,
    ),
  );
  const backup = path.join(dir, "backups", fx.officialHash, "app.asar");
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(fx.asarPath, backup);
  return dir;
}

test("legacy manifests migrate to one official baseline + tombstones survive", async () => {
  const mhDir = writeLegacyManifest("ZCODE_MODEL_HUB_STATE_DIR", "2024-01-02T00:00:00.000Z");
  writeLegacyManifest("ZCODE_PLUS_ASAR_STATE_DIR", "2024-03-01T00:00:00.000Z");
  const tomb = path.join(mhDir, "state.json");
  fs.writeFileSync(tomb, JSON.stringify({ deletedModels: { prov1: ["m-x"] } }), "utf8");

  const res = await install({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  // the earliest standalone install saw the official build -> its backup wins
  assert.equal(res.baselineSource, "legacy:modelhub");
  assert.equal(loadManifest().originalHash, fx.officialHash);
  assert.equal(backupCount(), 1, "both legacy backups must dedupe into one suite backup");

  const suiteState = JSON.parse(
    fs.readFileSync(path.join(process.env.ZCODE_SUITE_STATE_DIR, "state.json"), "utf8"),
  );
  assert.deepEqual(suiteState.deletedModels.prov1, ["m-x"], "tombstones must migrate");

  await restore({ resourcesOverride: fx.resourcesDir, _isRunning: notRunning });
  assert.equal(sha256File(fx.asarPath), fx.officialHash);
});
