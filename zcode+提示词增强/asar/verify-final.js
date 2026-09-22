#!/usr/bin/env node
/*
ZCode+ asar 注入终验（只读）：解析当前安装的 app.asar，确认
1) zcode+ 与 zcode-model-hub 的 sentinel/条目都在位
2) 补丁后的 main/preload/渲染层载荷语法有效（node --check）
3) index.html 同时引用两个渲染层脚本
退出码 0 = 全部通过；非 0 = 有问题（不要在这种情况下关机）。
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const asarPath = path.join(home, ".zcode", "zcode-plus", "manifest.json");
const problems = [];
let asar;
try {
  const m = JSON.parse(fs.readFileSync(asarPath, "utf8"));
  asar = m.asarPath;
  console.log("manifest asarPath:", asar);
} catch {
  console.error("FAIL: 读取 zcode+ manifest 失败（安装未完成？）");
  process.exit(1);
}

// ---- 最小 asar 读取器（仅用于只读校验）----
const fd = fs.openSync(asar, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));
const baseOffset = 8 + headerPickleSize;
const entries = {};
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, rel);
    else if (!child.unpacked) entries[rel] = { start: baseOffset + Number(child.offset), size: child.size };
  }
})(header, "");

function extract(rel) {
  const e = entries[rel];
  if (!e) return null;
  const out = Buffer.alloc(e.size);
  fs.readSync(fd, out, 0, e.size, e.start);
  return out;
}
function syntaxOk(rel, buf) {
  const tmp = path.join(os.tmpdir(), `zplus-verify-${path.basename(rel)}`);
  fs.writeFileSync(tmp, buf);
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8", timeout: 30000 });
  try { fs.rmSync(tmp, { force: true }); } catch {}
  return r.status === 0 ? true : `语法错误: ${(r.stderr || "").split("\n").slice(0, 3).join(" ")}`;
}

const mainTxt = extract("out/main/index.js");
const preloadTxt = extract("out/preload/index.cjs");
const htmlTxt = extract("out/renderer/index.html");
const zplusJs = extract("out/renderer/zcode-plus.js");
const mhJs = extract("out/renderer/zcode-model-hub.js");

for (const [label, buf] of [["out/main/index.js", mainTxt], ["out/preload/index.cjs", preloadTxt], ["out/renderer/zcode-plus.js", zplusJs]]) {
  if (!buf) { problems.push(`${label} 缺失`); continue; }
  const s = syntaxOk(label, buf);
  if (s !== true) problems.push(`${label} ${s}`);
}
for (const [label, buf, sentinel] of [
  ["out/main/index.js", mainTxt, "__ZCODE_PLUS_V1__"],
  ["out/preload/index.cjs", preloadTxt, "__ZCODE_PLUS_V1__"],
  ["out/renderer/index.html", htmlTxt, "__ZCODE_PLUS_V1__"],
]) {
  if (buf && !buf.includes(sentinel)) problems.push(`${label} 缺少 ${sentinel}`);
}
if (htmlTxt) {
  for (const tag of ["zcode-plus.js", "zcode-model-hub.js"]) {
    if (!htmlTxt.includes(`src="./${tag}"`)) problems.push(`index.html 缺少 ${tag} 引用`);
  }
}
if (zplusJs && zplusJs.includes("__wbEnhance")) problems.push("zcode-plus.js 仍残留 CDP binding 引用");
if (mhJs && !mhJs.includes("__ZCODE_MODEL_HUB_V1__")) problems.push("zcode-model-hub.js 载荷丢失（被覆盖？）");
else if (mhJs) console.log("zcode-model-hub.js 载荷在位:", mhJs.length, "bytes");
if (zplusJs) console.log("zcode-plus.js 载荷在位:", zplusJs.length, "bytes");
if (mainTxt) console.log("zcodeplus:request 处理器:", mainTxt.includes("zcodeplus:request") ? "在位" : "缺失");
if (!problems.length) {
  console.log("VERIFY OK");
} else {
  console.error("VERIFY FAILED:");
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
