// Feature registry — the single source of truth for what the suite injects.
// Every payload keeps its pre-suite sentinel, IPC namespace and window global,
// so a suite install is drop-in compatible with asars already patched by the
// standalone plugins (the two features were audited for collisions:
//   main     : __ZCODE_MODEL_HUB_V1_MAIN__ / modelhub:*   vs
//              __ZCODE_PLUS_V1_MAIN__    / zcodeplus:*
//   preload  : window.zcodeModelHub vs window.zcodePlus
//   renderer : separate files zcode-model-hub.js / zcode-plus.js,
//              disjoint UI guards, DOM id prefixes and localStorage keys).
export const FEATURE_ORDER = ["modelhub", "zcodeplus"];

export const FEATURES = {
  modelhub: {
    id: "modelhub",
    label: "model-hub 模型拉取",
    sentinel: "__ZCODE_MODEL_HUB_V1__",
    rendererScript: "zcode-model-hub.js",
    mainPayload: "modelhub/main-handlers.js",
    preloadPayload: "modelhub/preload-bridge.cjs",
    // used verbatim; entry is created inside app.asar next to index.html
    rendererPayload: "modelhub/ui/zcode-model-hub.js",
  },
  zcodeplus: {
    id: "zcodeplus",
    label: "zcode+ 提示词增强",
    sentinel: "__ZCODE_PLUS_V1__",
    rendererScript: "zcode-plus.js",
    mainPayload: "zcodeplus/main-handlers.js",
    preloadPayload: "zcodeplus/preload-bridge.cjs",
    // built at install time from the CDP-era inject.js via adaptInjectSource
    rendererPayload: null,
  },
};

// Renderer payload version baked into the zcode+ script (inject.js reads it
// as globalThis.__zcodePlusControllerVersion; "asar" lineage kept for logs).
export const ZCODEPLUS_RENDERER_VERSION = "1.3.2-asar.suite-1.0.0";

export function canonicalFeatures(ids) {
  const set = new Set(ids);
  return FEATURE_ORDER.filter((id) => set.has(id));
}
