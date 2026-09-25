// Locate the files we patch inside app.asar by path shape, not by exact
// hardcoded paths. Node/minified-code anchors change per build; the out/
// layout survives far longer. Ambiguity = hard error.
// Each feature gets its OWN renderer script name — never share or reuse one,
// a suite repack would otherwise overwrite the other feature's UI payload.
import { listFiles, readEntryText } from "../core/surgical-asar.mjs";
import { FEATURES, FEATURE_ORDER } from "../core/features.mjs";

const EXCLUDE = /(^|\/)(node_modules|\.cache|test|tests|__tests__)(\/|$)/;

export function discoverTargets(archive) {
  const { files } = listFiles(archive);
  const visible = files.filter((f) => !f.unpacked && !EXCLUDE.test(f.rel));

  const find = (label, patterns, { required = true } = {}) => {
    for (const re of patterns) {
      const hits = visible.filter((f) => re.test(f.rel));
      if (hits.length === 1) return hits[0].rel;
      if (hits.length > 1)
        throw new Error(
          `ambiguous ${label} targets (${hits.length}): ${hits.map((h) => h.rel).join(", ")}`,
        );
    }
    if (required) throw new Error(`layout mismatch: ${label} not found in app.asar`);
    return null;
  };

  const main = find("main entry", [
    /^out\/main\/index\.js$/,
    /^out\/main\/index\.mjs$/,
    /^out\/main\/index\.cjs$/,
    /^(out|app|dist)\/main\/index\.(js|mjs|cjs)$/,
  ]);
  const preload = find("preload entry", [
    /^out\/preload\/index\.cjs$/,
    /^out\/preload\/index\.js$/,
    /^(out|app|dist)\/preload\/index\.(cjs|js)$/,
  ]);
  const rendererHtml = find("renderer index.html", [
    /^out\/renderer\/index\.html$/,
    /^(out|app|dist)\/renderer\/index\.html$/,
    /^index\.html$/,
  ]);

  const rendererScripts = {};
  for (const id of FEATURE_ORDER) {
    rendererScripts[id] = rendererHtml.replace(/index\.html$/, FEATURES[id].rendererScript);
  }
  if (new Set(Object.values(rendererScripts)).size !== FEATURE_ORDER.length)
    throw new Error("internal error: renderer script names collide between features");

  return { main, preload, rendererHtml, rendererScripts };
}

// Per-feature sentinel presence in main / preload / renderer html.
export function sentinelsPresent(archive, targets) {
  const texts = [targets.main, targets.preload, targets.rendererHtml].map((rel) =>
    readEntryText(archive, rel),
  );
  const out = {};
  for (const id of FEATURE_ORDER) {
    const s = FEATURES[id].sentinel;
    out[id] = texts.some((t) => !!t && t.includes(s));
  }
  return out;
}

// Detects markers left by the two upstream patches so we can refuse to stack.
export function detectForeignPatches(archive, targets) {
  const markers = [];
  const mainTxt = readEntryText(archive, targets.main) || "";
  const preloadTxt = readEntryText(archive, targets.preload) || "";
  const rendererTxt = readEntryText(archive, targets.rendererHtml) || "";
  if (mainTxt.includes("zcode:read-model-config") || mainTxt.includes("zcode:fetch-models-from-url"))
    markers.push("zcode-model-puller (HHQ-666)");
  if (preloadTxt.includes("modelhubFetchModels") || rendererTxt.includes("__mhPick"))
    markers.push("zcode-modelhub-patch (CSSZYF)");
  return markers;
}
