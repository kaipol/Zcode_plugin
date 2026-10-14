/*
ZCode 会话回退 / 分支(session rewind)注入脚本 —— zcode-suite 特性 3。
社区实现,非 ZCode 官方产品。

作用:在输入框工具条注入「会话回退」按钮(history 时钟图标,风格取自 Lucide)。点击后
在**当前会话窗口内**弹出模态面板(不覆盖整个应用),按会话库中的真实用户轮次列出历史:
  · 主列表只列当前分支上可回退的轮次,最新的排在最上面;
  · 被之前回退移出分支的轮次收进「已隐藏」子面板,只读展示,不干扰主流程;
  · 点「回退到此轮之前」在面板内二次确认,确认后自动向输入框写入并发送
    /rewind cascade conversation <messageId> —— 会话回退到该轮之前(工作区文件不改动)。
  · 「分叉新会话」确认后自动发送 /fork —— 从最新工作区检查点分叉出新会话。
命令由 ZCode 运行时自己执行与持久化,本脚本只做"列历史 + 受信写入 + 自动发送"。

依赖:window.zcodeSessionRewind(preload 注入)。
*/
(() => {
  "use strict";
  if (window.__ZCODE_SESSION_REWIND_V1_UI__) return;
  window.__ZCODE_SESSION_REWIND_V1_UI__ = true;

  const VERSION = globalThis.__zcodeSessionRewindVersion || "dev";
  const OWNER = "session-rewind-v1";
  const BUTTON_ID = `zcode-sr-btn-${OWNER}`;
  const PANEL_ID = `zcode-sr-panel-${OWNER}`;
  const STYLE_ID = `zcode-sr-style-${OWNER}`;
  const TOAST_ID = `zcode-sr-toast-${OWNER}`;
  const POLL_MS = 1200;

  const COMPOSER_SELECTORS = ['[data-testid="v4-composer"]', '[data-testid="chat-composer"]', '[data-testid="chat-input"]'];
  const INPUT_SELECTORS = ['[data-testid="v4-composer-input"]', '[data-testid="chat-input"]'];
  const MODE_ANCHOR_SELECTORS = [
    '[data-testid="chat-mode-select-trigger"]',
    '[data-testid="chat-thought-level-select-trigger"]',
    '[data-testid="chat-attachment-button"]',
    '[data-testid="v4-composer-cua-entry"]',
    '[data-testid="chat-send-button"]',
    '[data-testid="v4-composer-send"]',
  ];
  const SEND_SELECTORS = ['[data-testid="chat-send-button"]', '[data-testid="v4-composer-send"]', 'button[type="submit"]'];

  let disposed = false;
  const listeners = [];
  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  // ---- 桥接 ----
  function available() {
    return window.zcodeSessionRewind && typeof window.zcodeSessionRewind.request === "function";
  }
  function clientRequest(type, extra = {}) {
    if (!available()) {
      return Promise.reject(new Error("会话回退主进程未连接:请确认 zcode-suite 已安装并重启 ZCode"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("请求超时(15 秒)")), 15000);
      window.zcodeSessionRewind.request(JSON.stringify({ type, ...extra })).then(
        (payloadJson) => {
          clearTimeout(timer);
          let data;
          try { data = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson; } catch { data = { ok: false, error: "返回数据无效" }; }
          if (data && data.ok) resolve(data);
          else reject(new Error((data && data.error) || "处理失败"));
        },
        (error) => { clearTimeout(timer); reject(new Error(String((error && error.message) || error))); },
      );
    });
  }

  // ---- DOM 工具 ----
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findComposerScope() {
    const scopes = [];
    for (const sel of COMPOSER_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el && isVisible(el) && !scopes.includes(el)) scopes.push(el);
      }
    }
    if (!scopes.length) return null;
    const focused = scopes.find((s) => s.contains(document.activeElement));
    if (focused) return focused;
    return scopes.reduce((best, el) => (el.getBoundingClientRect().top > best.getBoundingClientRect().top ? el : best), scopes[0]);
  }
  function findComposerInput() {
    const scope = findComposerScope();
    const root = scope || document;
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el) && (el.tagName === "TEXTAREA" || el.isContentEditable)) return el;
    }
    let best = null, bestTop = -Infinity;
    for (const el of root.querySelectorAll('textarea, [contenteditable="true"]')) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 24) continue;
      if (scope && !scope.contains(el)) continue;
      if (r.top < window.innerHeight * 0.3) continue;
      if (r.top > bestTop) { bestTop = r.top; best = el; }
    }
    return best;
  }
  function readText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    return el.innerText || el.textContent || "";
  }
  // 会话窗口根节点:优先取当前输入框所在的分屏/会话,避免多窗格时认错。
  function findSessionPane() {
    const scope = findComposerScope();
    if (scope) {
      const own = scope.closest("[data-session-id]");
      if (own && isVisible(own)) return own;
    }
    const nodes = [...document.querySelectorAll("[data-session-id]")].filter(isVisible);
    if (!nodes.length) return null;
    return nodes.reduce((best, el) => {
      const r = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return r.width * r.height > b.width * b.height ? el : best;
    });
  }
  function currentSessionId() {
    const pane = findSessionPane();
    const id = pane && pane.getAttribute("data-session-id");
    return id && id !== "draft" ? id : "";
  }

  // ---- 样式 ----
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      #${BUTTON_ID} {
        display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
        flex: 0 0 30px; width: 30px; min-width: 30px; height: 30px; padding: 0; margin: 0 2px;
        border: none; border-radius: 8px; cursor: pointer; background: transparent; color: inherit;
        line-height: 1; transition: background .15s ease; vertical-align: middle;
      }
      #${BUTTON_ID}:hover { background: rgba(127,127,127,.18); }
      #${BUTTON_ID}[data-open="1"] { background: rgba(127,127,127,.22); }
      #${BUTTON_ID} svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
      #${TOAST_ID} {
        position: fixed; bottom: 140px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        box-sizing: border-box; padding: 8px 12px; border-radius: 8px; max-width: min(560px, calc(100vw - 32px));
        background: rgba(30,30,30,.92); color: #fff; font: 13px/20px system-ui, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); pointer-events: none; overflow-wrap: anywhere;
        opacity: 0; visibility: hidden; transition: opacity .15s ease;
      }
      #${TOAST_ID}[data-show="1"] { opacity: 1; visibility: visible; }
      #${TOAST_ID}[data-kind="err"] { background: rgba(160,40,40,.95); }
      /* 模态遮罩默认铺满视口;打开时会按会话窗口 rect 收窄(见 positionOverlay),
         使其视觉上只属于当前会话窗口,而不是覆盖整个应用。 */
      #${PANEL_ID} { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.35);
        display: flex; align-items: center; justify-content: center; padding: 14px; border-radius: 10px;
        color-scheme: light dark; font: 13px/1.5 system-ui, sans-serif; }
      #${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} [hidden] { display: none !important; }
      #${PANEL_ID} .sr-panel { width: 560px; max-width: 100%; max-height: 100%;
        background: var(--theme-surface-color, light-dark(#fff,#242424));
        color: var(--theme-color-text, light-dark(#222,#eee)); border-radius: 10px;
        box-shadow: 0 10px 40px rgba(0,0,0,.3); display: flex; flex-direction: column; overflow: hidden; }
      #${PANEL_ID} .sr-header, #${PANEL_ID} .sr-footer { display: flex; align-items: center; gap: 8px; padding: 12px 18px; flex: 0 0 auto; }
      #${PANEL_ID} .sr-header { border-bottom: 1px solid rgba(127,127,127,.22); }
      #${PANEL_ID} .sr-footer { border-top: 1px solid rgba(127,127,127,.22); }
      #${PANEL_ID} h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; }
      #${PANEL_ID} h3 small { font-weight: 400; font-size: 12px; color: light-dark(#666,#bbb); }
      #${PANEL_ID} .sr-tabs { display: flex; gap: 6px; padding: 10px 18px 0; flex: 0 0 auto; }
      #${PANEL_ID} .sr-tabs button { flex: 1 1 0; min-height: 30px; padding: 4px 8px; border-radius: 7px;
        border: 1px solid transparent; background: rgba(127,127,127,.12); color: inherit;
        cursor: pointer; font: inherit; font-size: 12px; }
      #${PANEL_ID} .sr-tabs button:hover { background: rgba(127,127,127,.18); }
      #${PANEL_ID} .sr-tabs button[aria-selected="true"] { background: rgba(127,127,127,.24);
        border-color: rgba(127,127,127,.45); font-weight: 600; }
      #${PANEL_ID} .sr-count { opacity: .75; margin-left: 3px; }
      #${PANEL_ID} .sr-body { padding: 12px 18px 14px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
      #${PANEL_ID} .sr-note { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px;
        background: rgba(127,127,127,.12); color: light-dark(#444,#ccc); }
      #${PANEL_ID} button { flex-shrink: 0; min-height: 30px; padding: 4px 10px; border-radius: 6px;
        border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; font: inherit; }
      #${PANEL_ID} button:hover:not(:disabled) { background: rgba(127,127,127,.12); }
      #${PANEL_ID} button:disabled { opacity: .5; cursor: default; }
      #${PANEL_ID} button.sr-primary { background: light-dark(#222,#eee); color: light-dark(#fff,#222); border-color: transparent; font-weight: 600; }
      #${PANEL_ID} button.sr-primary:hover:not(:disabled) { background: light-dark(#444,#ccc); }
      #${PANEL_ID} button.sr-danger { border-color: rgba(200,60,60,.55); color: light-dark(#b02a2a,#ff9a9a); font-weight: 600; }
      #${PANEL_ID} button.sr-danger:hover:not(:disabled) { background: rgba(200,60,60,.14); }
      #${PANEL_ID} button.sr-icon { display: grid; place-items: center; width: 30px; padding: 0; border: 0; }
      #${PANEL_ID} button.sr-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.75; }
      #${PANEL_ID} .sr-status { margin-right: auto; min-width: 0; font-size: 12px; color: light-dark(#666,#bbb);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .sr-list { display: flex; flex-direction: column; gap: 6px; }
      #${PANEL_ID} .sr-turn { border: 1px solid rgba(127,127,127,.25); border-radius: 7px; padding: 8px 10px; }
      #${PANEL_ID} .sr-turn[data-hidden="1"] { opacity: .62; }
      #${PANEL_ID} .sr-turn[data-hidden="1"] .sr-badge { background: rgba(127,127,127,.25); }
      #${PANEL_ID} .sr-turn[data-current="1"] { border-color: light-dark(#2773c7,#88bfff); }
      #${PANEL_ID} .sr-meta { display: flex; align-items: center; gap: 8px; font-size: 12px;
        color: light-dark(#666,#bbb); margin-bottom: 4px; flex-wrap: wrap; }
      #${PANEL_ID} .sr-badge { padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.18); font-size: 11px; }
      #${PANEL_ID} .sr-badge.sr-cur { background: light-dark(#dbe9fb,#2b425f); color: light-dark(#16508f,#cfe3ff); }
      #${PANEL_ID} .sr-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 88px; overflow-y: auto; }
      #${PANEL_ID} .sr-actions { display: flex; gap: 8px; margin-top: 8px; }
      #${PANEL_ID} .sr-empty { padding: 20px; text-align: center; color: light-dark(#666,#bbb); }
      #${PANEL_ID} .sr-confirm-title { margin: 2px 0 10px; font-size: 14px; font-weight: 600; }
      #${PANEL_ID} .sr-confirm-lines p { margin: 0 0 9px; }
      #${PANEL_ID} .sr-quote { display: block; padding: 8px 10px; border-radius: 6px;
        background: rgba(127,127,127,.12); overflow-wrap: anywhere; }
      #${PANEL_ID} .sr-warn { color: light-dark(#a35b00,#ffc46b); }
      #${PANEL_ID} code { font: 12px ui-monospace, monospace; background: rgba(127,127,127,.15);
        padding: 1px 4px; border-radius: 3px; overflow-wrap: anywhere; }
      #${PANEL_ID} :focus-visible { outline: 2px solid light-dark(#2773c7,#88bfff); outline-offset: 2px; }
    `;
    document.head.appendChild(st);
  }

  // ---- Toast ----
  let toastTimer = 0;
  function ensureToast() {
    if (document.getElementById(TOAST_ID)) return;
    const t = document.createElement("div");
    t.id = TOAST_ID;
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  function toast(msg, kind) {
    if (disposed) return;
    ensureToast();
    const t = document.getElementById(TOAST_ID);
    if (!t) return;
    t.textContent = msg;
    t.dataset.kind = kind === "err" ? "err" : "ok";
    t.dataset.show = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (t) t.dataset.show = "0"; }, kind === "err" ? 5000 : 2500);
  }

  // ---- 写入斜杠命令并自动发送 ----
  function waitUntil(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      (function poll() {
        let ok = false;
        try { ok = !!check(); } catch { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 40);
      })();
    });
  }
  function findSendButton() {
    const scope = findComposerScope() || document;
    for (const sel of SEND_SELECTORS) {
      const el = scope.querySelector(sel) || document.querySelector(sel);
      if (el && isVisible(el) && !el.disabled) return el;
    }
    return null;
  }
  // 同一个按钮在生成中会变成"停止"。自动发送绝不能盲点:先看会话是否正在生成,
  // 再看按钮可访问名。命中停止就跳过点击、改走受信 Enter(生成中发送由运行时排队)。
  function isGenerating() {
    const pane = findSessionPane() || document;
    for (const el of pane.querySelectorAll('[data-running="true"]')) {
      if (isVisible(el)) return true;
    }
    return false;
  }
  function isStopButton(btn) {
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`;
    return /stop|中止|停止|中断/i.test(label);
  }
  // 自动发送:① 空闲时点击可用的发送按钮;② 其余情况(生成中/按钮不可用)走主进程
  // 受信 Enter。每步都以"命令已不在输入框里"为准判断是否真的发出,避免假成功。
  async function runSlashCommand(command) {
    const input = findComposerInput();
    if (!input) throw new Error("未找到输入框");
    input.focus({ preventScroll: true });
    await clientRequest("insertText", { text: command });
    const commandText = String(command).trim();
    const composerText = () => {
      const el = input.isConnected ? input : findComposerInput();
      return el ? readText(el).trim() : null;
    };
    if (!(await waitUntil(() => composerText() === commandText, 1200))) {
      throw new Error("输入框未接受命令,请手动粘贴:" + command);
    }
    const leftComposer = () => composerText() !== commandText;
    if (!isGenerating()) {
      let btn = null;
      await waitUntil(() => {
        const b = findSendButton();
        btn = b && !isStopButton(b) ? b : null;
        return !!btn;
      }, 1500);
      if (btn) {
        btn.click();
        if (await waitUntil(leftComposer, 1500)) return { sent: true, via: "button" };
      }
    }
    await clientRequest("submit");
    if (await waitUntil(leftComposer, 1500)) return { sent: true, via: "enter" };
    throw new Error("命令已写入输入框但未能自动发送,请手动按 Enter 发送");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtTime(ms) {
    try { return new Date(ms).toLocaleString(); } catch { return ""; }
  }

  // ---- 会话窗口内的模态面板 ----
  let panelOpen = false;
  let panelCleanup = null;

  async function openPanel() {
    if (disposed || panelOpen) return;
    const sessionId = currentSessionId();
    if (!sessionId) { toast("当前没有活动会话(新草稿);先开始一个会话", "err"); return; }
    ensureStyles();
    panelOpen = true;

    const overlay = document.createElement("div");
    overlay.id = PANEL_ID;
    overlay.innerHTML = `
      <div class="sr-panel" role="dialog" aria-modal="true" aria-labelledby="sr-title" tabindex="-1">
        <header class="sr-header">
          <h3 id="sr-title">会话回退 / 分支 <small>${escapeHtml(VERSION)}</small></h3>
          <button class="sr-icon" data-sr="close" type="button" aria-label="关闭" title="关闭">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>
          </button>
        </header>
        <div class="sr-tabs" data-sr="tabs" role="tablist" hidden></div>
        <div class="sr-body" data-sr="body"></div>
        <footer class="sr-footer" data-sr="footer"></footer>
      </div>`;
    document.body.appendChild(overlay);
    const q = (k) => overlay.querySelector(`[data-sr="${k}"]`);
    const tabsEl = q("tabs"), body = q("body"), footer = q("footer");

    // 把遮罩收窄到当前会话窗口的矩形,使弹窗"属于"会话窗口。
    function positionOverlay() {
      const pane = findSessionPane();
      const r = pane ? pane.getBoundingClientRect() : null;
      if (!r || r.width < 240 || r.height < 200) {
        overlay.style.left = ""; overlay.style.top = "";
        overlay.style.width = ""; overlay.style.height = "";
        overlay.style.right = ""; overlay.style.bottom = "";
        return;
      }
      overlay.style.left = Math.round(r.left) + "px";
      overlay.style.top = Math.round(r.top) + "px";
      overlay.style.width = Math.round(r.width) + "px";
      overlay.style.height = Math.round(r.height) + "px";
      overlay.style.right = "auto";
      overlay.style.bottom = "auto";
    }
    const onResize = () => positionOverlay();
    positionOverlay();
    window.addEventListener("resize", onResize);
    document.getElementById(BUTTON_ID)?.setAttribute("data-open", "1");

    let data = null;
    let tab = "active";         // "active"(当前分支) | "hidden"(已隐藏子面板)
    let view = "list";          // "list" | "confirm"
    let confirmSpec = null;

    function close() {
      overlay.remove();
      panelOpen = false;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside, true);
      document.getElementById(BUTTON_ID)?.setAttribute("data-open", "0");
      panelCleanup = null;
    }
    function onKey(ev) {
      if (ev.key !== "Escape" || !overlay.isConnected) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (view === "confirm") { backToList(); return; }
      close();
    }
    // 点面板外(如侧栏)也关闭:遮罩只覆盖会话窗口,不阻挡应用其余部分,
    // 若不监听就会留下一块"看着像卡住"的弹窗。
    function onOutside(ev) {
      if (!overlay.isConnected) return;
      if (overlay.contains(ev.target)) return;
      if (ev.target.closest?.(`#${BUTTON_ID}`)) return;
      close();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    q("close").addEventListener("click", close);

    function setStatus(t) {
      const s = footer.querySelector('[data-sr="status"]');
      if (s) s.textContent = t || "";
    }
    function backToList() { view = "list"; confirmSpec = null; render(); }

    function counts() {
      const turns = (data && data.turns) || [];
      return { active: turns.filter((t) => t.visible), hidden: turns.filter((t) => !t.visible) };
    }

    async function loadTurns() {
      view = "list";
      confirmSpec = null;
      tabsEl.hidden = true;
      body.innerHTML = '<div class="sr-empty">读取中...</div>';
      footer.innerHTML = "";
      try {
        data = await clientRequest("listTurns", { sessionId });
        render();
      } catch (error) {
        data = null;
        body.innerHTML = `<div class="sr-empty">读取失败:${escapeHtml(String(error.message || error))}</div>`;
        footer.innerHTML = '<span class="sr-status">读取失败</span>';
      }
    }

    function render() {
      if (view === "confirm" && confirmSpec) return renderConfirm();
      return renderList();
    }

    function renderList() {
      const { active, hidden } = counts();
      if (tab === "hidden" && !hidden.length) tab = "active";

      // 只有存在隐藏轮次时才出现子面板标签,默认不把它们混进主列表。
      if (hidden.length) {
        tabsEl.hidden = false;
        tabsEl.innerHTML = `
          <button type="button" role="tab" data-sr-tab="active" aria-selected="${tab === "active"}">当前分支<span class="sr-count">${active.length}</span></button>
          <button type="button" role="tab" data-sr-tab="hidden" aria-selected="${tab === "hidden"}">已隐藏<span class="sr-count">${hidden.length}</span></button>`;
        for (const btn of tabsEl.querySelectorAll("[data-sr-tab]")) {
          btn.addEventListener("click", () => { tab = btn.dataset.srTab; render(); });
        }
      } else {
        tabsEl.hidden = true;
        tabsEl.innerHTML = "";
      }

      const list = tab === "hidden" ? hidden : active;
      // 倒序:最新的对话排在最上面。
      const ordered = [...list].sort((a, b) => b.sequence - a.sequence);
      const tipId = tab === "active" && ordered.length ? ordered[0].messageId : null;

      body.innerHTML = tab === "hidden"
        ? '<p class="sr-note">这些轮次已被之前的回退移出当前分支,不再出现在会话里,也不能被再次回退;原始记录仍保留在会话库中。</p><div class="sr-list" data-sr="list"></div>'
        : '<p class="sr-note">回退会把会话截断到所选提问<b>之前</b>(工作区文件不改动);确认后命令自动发送,之后可用当前(已切换的)模型继续。</p><div class="sr-list" data-sr="list"></div>';
      const listEl = body.querySelector('[data-sr="list"]');
      if (!ordered.length) {
        listEl.innerHTML = `<div class="sr-empty">${tab === "hidden" ? "没有已隐藏的轮次。" : "该会话还没有可回退的用户提问。"}</div>`;
      } else {
        for (const turn of ordered) {
          listEl.appendChild(buildTurnRow(turn, { readOnly: tab === "hidden", tip: turn.messageId === tipId }));
        }
      }

      footer.innerHTML = `
        <span class="sr-status" data-sr="status"></span>
        <button data-sr="reload" type="button">刷新</button>
        <button data-sr="fork" type="button">分叉新会话</button>`;
      footer.querySelector('[data-sr="reload"]').addEventListener("click", () => void loadTurns());
      footer.querySelector('[data-sr="fork"]').addEventListener("click", () => startFork());
      setStatus(tab === "hidden" ? `已隐藏 ${hidden.length} 轮` : `当前分支可回退 ${active.length} 轮`);
    }

    function buildTurnRow(turn, { readOnly, tip }) {
      const row = document.createElement("div");
      row.className = "sr-turn";
      if (readOnly) row.dataset.hidden = "1";
      if (tip) row.dataset.current = "1";
      const badges = [];
      if (tip) badges.push('<span class="sr-badge sr-cur">最新</span>');
      if (readOnly) badges.push('<span class="sr-badge">已隐藏</span>');
      badges.push(`<span class="sr-badge">#${turn.sequence}</span>`);
      if (turn.model) badges.push(`<span class="sr-badge">${escapeHtml(turn.model)}</span>`);
      row.innerHTML = `
        <div class="sr-meta">${badges.join("")}<span>${escapeHtml(fmtTime(turn.time))}</span></div>
        <div class="sr-text">${escapeHtml(turn.text || turn.preview || "(空)")}</div>`;
      if (!readOnly) {
        const actions = document.createElement("div");
        actions.className = "sr-actions";
        const rewind = document.createElement("button");
        rewind.type = "button";
        rewind.className = "sr-primary";
        rewind.textContent = "回退到此轮之前";
        rewind.addEventListener("click", () => startRewindConfirmation(turn));
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "复制命令";
        copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(buildRewindCommand(turn.messageId)); toast("命令已复制", "ok"); }
          catch { toast("无法访问剪贴板", "err"); }
        });
        actions.append(rewind, copy);
        row.appendChild(actions);
      }
      return row;
    }

    function buildRewindCommand(messageId) {
      return `/rewind cascade conversation ${messageId}`;
    }

    // 输入框里已有的草稿会被受信写入替换,确认前先告知,避免静默丢稿。
    function draftWarning() {
      const input = findComposerInput();
      const draft = input ? readText(input).trim() : "";
      return draft ? "输入框里已有内容,发送命令会替换它(未发送的草稿会丢失)。" : "";
    }

    function renderConfirm() {
      tabsEl.hidden = true;
      body.innerHTML = `
        <h4 class="sr-confirm-title">${confirmSpec.title}</h4>
        <div class="sr-confirm-lines">${confirmSpec.lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
      footer.innerHTML = `
        <span class="sr-status" data-sr="status"></span>
        <button data-sr="back" type="button">返回</button>
        <button data-sr="ok" type="button" class="${confirmSpec.danger ? "sr-danger" : "sr-primary"}">${confirmSpec.okText}</button>`;
      const back = footer.querySelector('[data-sr="back"]');
      const ok = footer.querySelector('[data-sr="ok"]');
      back.addEventListener("click", backToList);
      ok.addEventListener("click", async () => {
        ok.disabled = true;
        back.disabled = true;
        setStatus("正在写入并发送命令...");
        try {
          await confirmSpec.run();
        } catch (error) {
          ok.disabled = false;
          back.disabled = false;
          setStatus("失败");
          toast(String(error.message || error), "err");
        }
      });
      ok.focus();
    }

    function startRewindConfirmation(turn) {
      const warn = draftWarning();
      view = "confirm";
      confirmSpec = {
        title: "确认回退并发送",
        danger: true,
        okText: "回退并自动发送",
        lines: [
          "会话将回退到这一轮提问<b>之前</b>:",
          `<span class="sr-quote">「${escapeHtml((turn.preview || turn.text || "").slice(0, 90))}」</span>`,
          "该轮及其之后的回答会被移出当前分支(<b>工作区文件不改动</b>),之后可用当前模型继续。",
          `确认后自动发送:<code>/rewind cascade conversation ${escapeHtml(turn.messageId.slice(0, 24))}...</code>`,
          warn ? `<span class="sr-warn">${warn}</span>` : "",
        ].filter(Boolean),
        run: async () => {
          await runSlashCommand(buildRewindCommand(turn.messageId));
          toast("已发送回退命令,运行时处理后会刷新会话", "ok");
          close();
        },
      };
      render();
    }

    function startFork() {
      const warn = draftWarning();
      view = "confirm";
      confirmSpec = {
        title: "确认分叉并发送",
        danger: false,
        okText: "分叉并自动发送",
        lines: [
          "将从<b>最新工作区检查点</b>分叉出一个新会话(原会话保留)。",
          "确认后自动发送:<code>/fork</code>",
          warn ? `<span class="sr-warn">${warn}</span>` : "",
        ].filter(Boolean),
        run: async () => {
          await runSlashCommand("/fork");
          toast("已发送分叉命令,运行时处理后会创建新会话", "ok");
          close();
        },
      };
      render();
    }

    panelCleanup = close;
    void loadTurns();
  }

  // ---- 按钮注入 ----
  function findModeAnchor(scope) {
    if (!scope) return null;
    const containers = [scope, scope.parentElement, scope.parentElement?.parentElement];
    for (let depth = 0; depth < containers.length; depth++) {
      const node = containers[depth];
      if (!node) continue;
      for (const sel of MODE_ANCHOR_SELECTORS) {
        const anchor = node.querySelector(sel);
        if (!anchor || !isVisible(anchor)) continue;
        if (depth > 0 && anchor.closest(COMPOSER_SELECTORS.join(",")) !== scope) continue;
        return { anchor, insertAfter: !/send-button|composer-send/.test(sel) };
      }
    }
    return null;
  }
  function findAnchorFallback(input) {
    let node = input;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const btns = [...node.querySelectorAll("button")].filter(isVisible);
      if (btns.length) return { anchor: btns[btns.length - 1], insertAfter: false };
    }
    return null;
  }
  function ensureButton() {
    if (disposed) return;
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
      if (existing.isConnected) return;
      existing.remove();
    }
    const input = findComposerInput();
    if (!input) return;
    const scope = findComposerScope();
    const found = findModeAnchor(scope) || findAnchorFallback(input);
    if (!found) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.dataset.open = panelOpen ? "1" : "0";
    btn.title = "会话回退 / 分支(列出历史轮次,可回退或用当前模型继续)";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-haspopup", "dialog");
    // history 图标(时钟 + 逆时针箭头):一眼读出"历史轮次 / 回退"。
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M12 7v5l4 2"/></svg>`;
    // 开面板时按钮即开关:再点一次关闭(外点/ Esc 也关闭)。
    btn.addEventListener("click", () => {
      if (panelOpen) { panelCleanup?.(); return; }
      void openPanel();
    });
    try {
      if (found.insertAfter) found.anchor.after(btn);
      else found.anchor.before(btn);
    } catch {
      found.anchor.parentNode?.appendChild(btn);
    }
  }

  // ---- 生命周期 ----
  let pollTimer = 0, mutationTimer = 0;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(ensureButton, 200);
  });
  function start() {
    if (disposed) return;
    ensureStyles();
    ensureButton();
    pollTimer = setInterval(ensureButton, POLL_MS);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  globalThis.__zcodeSessionRewindRuntime = {
    version: VERSION,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      clearTimeout(mutationTimer);
      clearInterval(pollTimer);
      clearTimeout(toastTimer);
      try { panelCleanup?.(); } catch {}
      for (const remove of listeners.splice(0)) remove();
      for (const id of [BUTTON_ID, PANEL_ID, TOAST_ID, STYLE_ID]) document.getElementById(id)?.remove();
    },
  };
  if (document.readyState === "loading") listen(document, "DOMContentLoaded", start);
  else start();
})();