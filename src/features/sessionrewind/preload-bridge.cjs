/* __ZCODE_SESSION_REWIND_V1__ preload bridge (appended block, asar 注入版).
 * Self-contained; safe to remove this whole block to uninstall.
 * Exposes window.zcodeSessionRewind.request(payload) -> Promise<result>.
 * 页面脚本(session-rewind UI)经此与主进程 sessionrewind:request 通信,
 * 协议与 zcodeplus/modelhub 同构({type,...} 进、{ok,...} 出)。
 */
;(function () {
  try {
    if (globalThis.__ZCODE_SESSION_REWIND_V1_PRELOAD__) return;
    globalThis.__ZCODE_SESSION_REWIND_V1_PRELOAD__ = true;
    var electron = require("electron");
    electron.contextBridge.exposeInMainWorld("zcodeSessionRewind", {
      version: 1,
      request: function (payload) {
        return electron.ipcRenderer
          .invoke("sessionrewind:request", String(payload))
          .then(function (result) {
            return typeof result === "string" ? result : JSON.stringify(result);
          });
      },
    });
  } catch (e) {
    try { console.error("[session-rewind] preload bridge failed:", (e && e.message) || e); } catch {}
  }
})();