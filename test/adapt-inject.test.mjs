// The inject.js -> asar renderer adaptation must keep working against the
// shipped inject.js: anchors unique, CDP binding fully replaced, payload
// parses as a classic script.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { payloadText } from "../src/features/payloads.mjs";
import { adaptInjectSource } from "../src/features/zcodeplus/adapt.mjs";

test("adaptInjectSource converts the shipped inject.js cleanly", () => {
  const src = payloadText("zcodeplus/inject.js");
  const out = adaptInjectSource(src, "1.3.2-asar.test");

  assert.ok(out.startsWith("globalThis.__zcodePlusControllerVersion = "), "version header missing");
  assert.ok(!out.includes("__wbEnhance"), "CDP binding reference survived");
  assert.ok(out.includes('typeof window.zcodePlus === "object"'), "trusted-input guard not switched");
  assert.ok(out.includes("无法联系 ZCode+ 主进程服务"), "IPC error path missing");
  assert.ok(out.includes('localStorage'), "workspace path reader missing");

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adapt-")), "payload.js");
  fs.writeFileSync(tmp, out, "utf8");
  const chk = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  assert.equal(chk.status, 0, `adapted payload must parse: ${chk.stderr}`);
});

test("adaptInjectSource hard-fails on a corrupted inject.js", () => {
  const src = payloadText("zcodeplus/inject.js");
  const broken = src.replace('typeof window.__wbEnhance === "function"', "true");
  assert.throws(() => adaptInjectSource(broken, "x"), /受信输入通道守卫/);
  assert.throws(() => adaptInjectSource("no anchors here", "x"), /锚点/);
});
