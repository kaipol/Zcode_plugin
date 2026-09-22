/* __ZCODE_PLUS_V1__ preload bridge (appended block, asar 注入版).
 * Self-contained; safe to remove this whole block to uninstall.
 * Exposes window.zcodePlus.request(payload) -> Promise<result JSON string>.
 * 页面脚本（inject.js 移植版）经此与主进程 zcodeplus:request 通信，
 * 协议与原 CDP binding 版保持同构（{type,id,...} 进、{ok,...} 出）。
 */
;(function () {
  try {
    if (globalThis.__ZCODE_PLUS_V1_PRELOAD__) return;
    globalThis.__ZCODE_PLUS_V1_PRELOAD__ = true;
    var electron = require("electron");
    electron.contextBridge.exposeInMainWorld("zcodePlus", {
      version: 1,
      request: function (payload) {
        return electron.ipcRenderer
          .invoke("zcodeplus:request", String(payload))
          .then(function (result) {
            return typeof result === "string" ? result : JSON.stringify(result);
          });
      },
    });
  } catch (e) {
    try {
      console.error("[zcode-plus] preload bridge failed:", (e && e.message) || e);
    } catch {}
  }
})();
