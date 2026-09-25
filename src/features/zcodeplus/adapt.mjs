// Adapts the CDP-era inject.js into the asar renderer payload: the
// "talk to the local controller over a Runtime binding" block is replaced
// by "talk to the main-process service over contextBridge + IPC", and the
// trusted-input channel guard switches from window.__wbEnhance to
// window.zcodePlus. Every anchor must match exactly once — a mismatch
// means inject.js changed shape and we refuse rather than write a broken
// page script.
const A_START = "  // ---- 与控制器的 binding 通信 ----";
const A_END = [
  '        reject(new Error("无法联系 ZCode+ 控制器：" + String(error?.message || error)));',
  "      }",
  "    });",
  "  }",
].join("\n");
const A_REPLACEMENT = `  // ---- 与 ZCode+ 主进程服务的通信（asar 注入版：contextBridge + IPC）----
  let requestSeq = 0;
  function readWorkspacePaths() {
    // 从 localStorage 的 last-session 键提取工作区路径（主进程据此读工作区级 provider 池）
    try {
      const prefix = "zcode-v4-last-session:v1:";
      return Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        // ZCode Windows 存盘符路径、Linux 存 POSIX 绝对路径（/home/...），两种形态都放行
        .filter((p) => /^[A-Za-z]:[\\\\/]/.test(p) || p.startsWith("/"));
    } catch { return []; }
  }
  function controllerRequest(type, extra = {}, manualOverride) {
    if (!window.zcodePlus || typeof window.zcodePlus.request !== "function") {
      return Promise.reject(new Error("未检测到 ZCode+ 注入：请运行 zcode+ 安装器（node asar-install.mjs install）后重启 ZCode"));
    }
    const id = ++requestSeq;
    const s = loadSettings();
    // manualOverride：设置面板传入表单当前值（未保存即生效）；null 表示显式走自动模式
    const manual = manualOverride !== undefined ? manualOverride
      : s.mode === "manual"
        ? { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, protocol: s.protocol, omitStore: s.omitStore }
        : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("请求超过 90 秒，原文已保留")), REQUEST_TIMEOUT_MS);
      window.zcodePlus.request(JSON.stringify({ type, id, manual, thinking: s.thinking, modelLabel: readModelLabel(), workspacePaths: readWorkspacePaths(), ...extra }))
        .then((payloadJson) => {
          clearTimeout(timer);
          let data;
          try { data = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson; } catch { data = { ok: false, error: "ZCode+ 返回无效数据" }; }
          if (data && data.ok) resolve(data);
          else reject(new Error((data && data.error) || "ZCode+ 处理失败"));
        }, (error) => {
          clearTimeout(timer);
          reject(new Error("无法联系 ZCode+ 主进程服务：" + String(error?.message || error)));
        });
    });
  }`;
const C_OLD = 'typeof window.__wbEnhance === "function"';
const C_NEW = 'typeof window.zcodePlus === "object" && window.zcodePlus !== null && typeof window.zcodePlus.request === "function"';

function countOccurrences(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export function adaptInjectSource(source, version) {
  let out = source;
  const startCount = countOccurrences(out, A_START);
  if (startCount !== 1) throw new Error(`inject.js 适配失败：binding 区块锚点出现 ${startCount} 次（期望 1 次），inject.js 版本可能不兼容`);
  const startIdx = out.indexOf(A_START);
  const endIdx = out.indexOf(A_END, startIdx);
  if (endIdx < 0) throw new Error("inject.js 适配失败：controllerRequest 结尾锚点未找到");
  const endAbs = endIdx + A_END.length;
  out = out.slice(0, startIdx) + A_REPLACEMENT + out.slice(endAbs);
  const cCount = countOccurrences(out, C_OLD);
  if (cCount !== 2) throw new Error(`inject.js 适配失败：受信输入通道守卫出现 ${cCount} 次（期望 2 次）`);
  out = out.split(C_OLD).join(C_NEW);
  if (out.includes("__wbEnhance")) throw new Error("inject.js 适配失败：仍残留 CDP binding 引用（__wbEnhance）");
  return `globalThis.__zcodePlusControllerVersion = ${JSON.stringify(version)};\n` + out;
}
