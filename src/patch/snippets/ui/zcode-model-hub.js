/* __ZCODE_MODEL_HUB_V1__ renderer UI (injected as out/renderer/zcode-model-hub.js).
 * Adaptive by design: finds the "add model" button via semantic features
 * (button text / aria-label / i18n-ish hints) instead of minified identifiers,
 * and re-scans on DOM mutations so SPA navigation works across versions.
 * Requires window.zcodeModelHub (installed by the preload bridge). */
;(function () {
  "use strict";
  if (window.__ZCODE_MODEL_HUB_V1_UI__) return;
  window.__ZCODE_MODEL_HUB_V1_UI__ = true;

  var BTN_ID = "zcode-model-hub-btn";
  // Model-provider pages use「添加模型」(edit page) /「添加供应商」(list page);
  // other settings pages have their own bare「添加」buttons (e.g. the plugins
  // page) which must NOT get our button — so bare「添加」is deliberately not
  // matched, and a context guard rejects non-provider sections.
  var ADD_RE = /^(添加模型|添加供应商|新增模型|add model|add a model|add provider|new model)$/i;
  var CTX_BAD_RE = /插件|技能|\bMCP\b|plugin|skill/i;
  var CTX_GOOD_RE = /模型供应商|供应商|模型列表|模型 ID|Base\s*URL|API\s*格式/i;

  function inModelProviderSection(b) {
    var node = b;
    for (var up = 0; up < 6 && node; up++) {
      node = node.parentElement;
      if (!node || node === document.body) break;
      var txt = node.textContent || "";
      if (txt.length > 6000) txt = txt.slice(0, 6000);
      if (CTX_BAD_RE.test(txt)) return false;
      if (CTX_GOOD_RE.test(txt)) return true;
    }
    return false;
  }

  function api() {
    return window.zcodeModelHub || null;
  }

  function toast(msg, ok) {
    try {
      var d = document.createElement("div");
      d.textContent = msg;
      d.style.cssText =
        "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:420px;" +
        "padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;" +
        "color:#fff;background:" + (ok === false ? "#c0392b" : "#2d6cdf") + ";" +
        "box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .3s";
      document.body.appendChild(d);
      setTimeout(function () {
        d.style.opacity = "0";
        setTimeout(function () {
          d.remove();
        }, 350);
      }, 3200);
    } catch (e) {}
  }

  // ---- injection point discovery (semantic, multi-fallback) ----
  function findAddModelButtons() {
    var hits = [];
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.id === BTN_ID) continue;
      if (b.getAttribute("data-model-hub-near")) continue;
      var text = (b.textContent || "").trim().replace(/\s+/g, " ");
      var label = (b.getAttribute("aria-label") || b.title || "").trim();
      var okText = ADD_RE.test(text) && text.length <= 12;
      var okLabel = ADD_RE.test(label) && label.length <= 12;
      if (!okText && !okLabel) continue;
      if (!inModelProviderSection(b)) continue; // skip plugins/MCP/skills pages
      var r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // hidden
      hits.push(b);
    }
    return hits;
  }

  function ensureButtonNextTo(target) {
    var parent = target.parentElement;
    if (!parent) return;
    if (parent.querySelector("#" + BTN_ID)) return;
    parent.setAttribute("data-model-hub-near", "1");
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "⚡️ 拉取模型";
    btn.title = "zcode-model-hub：根据当前 Base URL 和 API Key 自动拉取可用模型列表";
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;" +
      "font-size:13px;font-weight:500;cursor:pointer;border:1px solid rgba(96,165,250,.45);" +
      "background:linear-gradient(135deg,rgba(96,165,250,.16),rgba(139,92,246,.14));" +
      "color:inherit;transition:filter .15s";
    btn.onmouseenter = function () {
      btn.style.filter = "brightness(1.12)";
    };
    btn.onmouseleave = function () {
      btn.style.filter = "";
    };
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onPullClick(btn);
    });
    try {
      parent.style.display = "flex";
      parent.style.flexWrap = "wrap";
      parent.style.alignItems = "center";
      parent.style.gap = parent.style.gap || "8px";
      parent.insertBefore(btn, target);
    } catch (e) {}
  }

  function checkAndInject() {
    if (!api()) return;
    var hits = findAddModelButtons();
    for (var i = 0; i < hits.length; i++) ensureButtonNextTo(hits[i]);
  }

  // ---- credentials from the visible form (with config fallback) ----
  function visibleInputs() {
    var out = [];
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var t = el.type || "text";
      if (t === "hidden" || t === "checkbox" || t === "radio" || t === "submit" || t === "button") continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push(el);
    }
    return out;
  }

  function scanFormCredentials() {
    var baseUrl = "";
    var apiKey = "";
    var inputs = visibleInputs();
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var v = (el.value || "").trim();
      var ph = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
      if (!baseUrl && /^https?:\/\//i.test(v)) baseUrl = v;
      if (!apiKey) {
        if (el.type === "password" && v) apiKey = v;
        else if (v && /^sk-[A-Za-z0-9]/.test(v)) apiKey = v;
        else if (v && /key|token|令牌|密钥/i.test(ph) && el.type !== "password" && v.length > 8 && !/^https?:/i.test(v))
          apiKey = v;
      }
    }
    return { baseUrl: baseUrl, apiKey: apiKey };
  }

  function readConfig() {
    return Promise.resolve(api().readConfig()).then(function (r) {
      if (r && r.ok) return r.data;
      throw new Error((r && r.error) || "read config failed");
    });
  }
  function writeConfig(cfg) {
    return Promise.resolve(api().writeConfig(cfg)).then(function (r) {
      if (r && r.ok) return true;
      throw new Error((r && r.error) || "write config failed");
    });
  }

  function normalizeUrlKey(u) {
    return String(u || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
  }

  // ---- latest-format views over provider_config.json (schemaVersion 1) ----
  function providerRulesOf(cfg) {
    var rules = cfg && cfg.config && cfg.config.providerConfigRules && cfg.config.providerConfigRules.providerRules;
    return Array.isArray(rules) ? rules : [];
  }
  function ruleBaseUrl(rule) {
    var c = (rule && rule.config) || {};
    var api = c.api || {};
    return String(api.baseUrl || api.baseURL || c.baseUrl || c.baseURL || "");
  }
  function ruleApiKey(rule) {
    var c = (rule && rule.config) || {};
    var access = c.access || {};
    return String(access.apiKey || c.apiKey || "");
  }
  function ruleName(rule) {
    return String((rule && (rule.providerName || rule.providerId || rule.name)) || "");
  }
  function ruleProviderId(rule) {
    return String((rule && (rule.providerId || rule.id)) || "");
  }

  function findProviderByBaseUrl(cfg, baseUrl) {
    var want = normalizeUrlKey(baseUrl);
    var rules = providerRulesOf(cfg);
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || typeof r !== "object") continue;
      var bu = ruleBaseUrl(r);
      if (bu && normalizeUrlKey(bu) === want) return { format: "rules", rule: r };
    }
    // legacy config.json fallback
    var sec = cfg.provider || {};
    var entries = Array.isArray(sec)
      ? sec.map(function (p, i) {
          return { key: i, p: p };
        })
      : Object.keys(sec).map(function (k) {
          return { key: k, p: sec[k] };
        });
    var hit = null;
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      if (!e.p || typeof e.p !== "object") continue;
      var lbu = (e.p.options && e.p.options.baseURL) || e.p.baseURL || "";
      if (!lbu) continue;
      if (normalizeUrlKey(lbu) === want) {
        hit = e;
        break;
      }
    }
    return hit ? { format: "legacy", key: hit.key, p: hit.p } : null;
  }

  // ---- tool state (~/.zcode/model-hub/state.json): per-provider tombstones ----
  function readDeletedSet(providerKey) {
    return Promise.resolve(api().readState ? api().readState() : { ok: true, data: {} }).then(function (r) {
      var st = r && r.ok && r.data && typeof r.data === "object" ? r.data : {};
      var map = st.deletedModels && typeof st.deletedModels === "object" ? st.deletedModels : {};
      var list = Array.isArray(map[String(providerKey)]) ? map[String(providerKey)] : [];
      var set = {};
      for (var i = 0; i < list.length; i++) set[String(list[i])] = 1;
      return set;
    });
  }
  function writeDeletedSet(providerKey, deleted) {
    if (!api().writeState) return Promise.resolve();
    return Promise.resolve(api().readState()).then(function (r) {
      var st = r && r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
      if (!st.schemaVersion) st.schemaVersion = 1;
      if (!st.deletedModels || typeof st.deletedModels !== "object" || Array.isArray(st.deletedModels)) st.deletedModels = {};
      var list = Object.keys(deleted).sort();
      if (list.length) st.deletedModels[String(providerKey)] = list;
      else delete st.deletedModels[String(providerKey)];
      return Promise.resolve(api().writeState(st)).then(function (w) {
        if (!w || !w.ok) throw new Error((w && w.error) || "write state failed");
      });
    });
  }

  // builtin templates (from the app's zcode-builtin.json, via main process):
  // template providers keep api.baseUrl there, not in the personal config.
  function readTemplates() {
    if (!api().readTemplates) return Promise.resolve([]);
    return Promise.resolve(api().readTemplates()).then(function (r) {
      return r && r.ok && Array.isArray(r.data) ? r.data : [];
    });
  }

  // URL -> provider rule. Direct api.baseUrl match first; then template
  // fallback (template's baseUrl -> personal rule with that templateId).
  function resolveProviderHit(cfg, baseUrl, templates) {
    var hit = findProviderByBaseUrl(cfg, baseUrl);
    if (hit) return hit;
    var want = normalizeUrlKey(baseUrl);
    var tpl = null;
    for (var i = 0; i < (templates || []).length; i++) {
      var t = templates[i];
      if (t && t.baseUrl && normalizeUrlKey(t.baseUrl) === want) {
        tpl = t;
        break;
      }
    }
    if (!tpl) return null;
    var rules = providerRulesOf(cfg);
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      if (r && typeof r === "object" && String(r.templateId || "") === tpl.templateId) {
        return { format: "rules", rule: r, template: tpl };
      }
    }
    return null;
  }

  // ---- existing models from DOM + config (for the "already added" badge) ----
  function existingModelIdsFromDom() {
    var set = {};
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var cls = el.className || "";
      var ph = el.getAttribute("placeholder") || "";
      if ((/font-mono|mono/i.test(String(cls)) || /模型|model/i.test(ph)) && el.value && el.value.trim()) {
        set[el.value.trim()] = 1;
      }
    }
    return set;
  }

  // ---- modal ----
  // "already saved" info per provider: visible set (已保存 tab), hidden set
  // (models disabled by an enabled:false rule — provider-model hide rules are
  // what ZCode itself writes, manual ones come from older plugin versions).
  // (The old DOM scan leaked model ids from OTHER providers' pages and made
  // every row show "已添加" with nothing selected -> "saved 0 models".)
  function savedHiddenSets(cfg, hit) {
    var visible = {};
    var hidden = {};
    if (!hit || hit.format !== "rules" || !hit.rule || typeof hit.rule !== "object") return { visible: visible, hidden: hidden };
    var c = hit.rule.config || {};
    var lists = [c.modelOrder, c.personalModelIds];
    if (hit.template && Array.isArray(hit.template.builtinModelIds)) lists.push(hit.template.builtinModelIds);
    for (var i = 0; i < lists.length; i++) {
      if (!Array.isArray(lists[i])) continue;
      for (var j = 0; j < lists[i].length; j++) visible[String(lists[i][j])] = 1;
    }
    var mcr = cfg && cfg.config && cfg.config.modelConfigRules;
    var pid = ruleProviderId(hit.rule);
    var lists2 = [mcr && mcr.manualProviderModelRules, mcr && mcr.providerModelRules];
    for (var li = 0; li < lists2.length; li++) {
      var rules = lists2[li];
      if (!Array.isArray(rules)) continue;
      for (var r = 0; r < rules.length; r++) {
        var mr = rules[r];
        if (!mr || typeof mr !== "object" || String(mr.providerId) !== pid) continue;
        var en = mr.config && typeof mr.config === "object" ? mr.config.enabled : undefined;
        if (en === false) {
          hidden[String(mr.modelId)] = 1;
          delete visible[String(mr.modelId)];
        }
      }
    }
    return { visible: visible, hidden: hidden };
  }

  function openModal(result, creds, sets, templates) {
    var state = {};
    var models = result.models || [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var isSaved = sets && sets.visible[m.id] === 1;
      var isHidden = sets && sets.hidden[m.id] === 1;
      // 已保存 models start checked (= keep); unchecking marks them for
      // deletion on save. Unsaved models start unchecked (= don't add);
      // checking adds them.
      state[m.id] = { savedVisible: isSaved, wasHidden: isHidden, selected: isSaved, vision: !!m.visionGuess, probing: false };
    }

    var overlay = document.createElement("div");
    overlay.id = "zcode-model-hub-modal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);" +
      "display:flex;align-items:center;justify-content:center";
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(620px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:14px;" +
      "overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4);font-size:13px;" +
      "background:" + (dark ? "#1e1f22" : "#ffffff") + ";color:" + (dark ? "#e6e6e6" : "#1a1a1a");

    function el(tag, style, text) {
      var d = document.createElement(tag);
      if (style) d.style.cssText = style;
      if (text != null) d.textContent = text;
      return d;
    }

    var header = el("div", "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid " + (dark ? "#333" : "#eee"));
    header.appendChild(el("div", "font-weight:600;font-size:14px", "拉取到 " + models.length + " 个模型（" + result.dialect + "）"));
    var closeBtn = el("button", "background:none;border:none;cursor:pointer;font-size:16px;color:inherit", "✕");
    closeBtn.addEventListener("click", function () {
      overlay.remove();
    });
    header.appendChild(closeBtn);

    var toolbar = el("div", "display:flex;gap:8px;align-items:center;padding:10px 18px;flex-wrap:wrap");
    var search = el("input", "flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid " + (dark ? "#444" : "#ddd") + ";background:transparent;color:inherit;font-size:13px");
    search.placeholder = "搜索模型…";
    toolbar.appendChild(search);
    function toolBtn(label, fn) {
      var b = el("button", "padding:5px 10px;border-radius:8px;cursor:pointer;border:1px solid " + (dark ? "#444" : "#ddd") + ";background:transparent;color:inherit;font-size:12px", label);
      b.addEventListener("click", fn);
      return b;
    }
    toolbar.appendChild(toolBtn("全选", function () { setAll(true); }));
    toolbar.appendChild(toolBtn("清空", function () { setAll(false); }));
    var probeBtn = toolBtn("探测视觉(勾选)", function () { probeChecked(); });
    toolbar.appendChild(probeBtn);

    // ---- sub views: 未保存 (default) / 已保存 ----
    var activeTab = "new";
    var tabBar = el("div", "display:flex;gap:6px;padding:10px 18px 0");
    var tabNew = el("button", "", "未保存");
    var tabSaved = el("button", "", "已保存");
    tabNew.type = tabSaved.type = "button";
    function tabStyle(active) {
      return "padding:5px 14px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid " +
        (active ? "transparent;background:#2d6cdf;color:#fff" : (dark ? "transparent;background:rgba(128,128,128,.15);color:inherit" : "transparent;background:rgba(128,128,128,.1);color:inherit"));
    }
    function refreshTabs() {
      var nNew = 0;
      var nSaved = 0;
      for (var k in state) {
        if (state[k].savedVisible) nSaved++;
        else nNew++;
      }
      tabNew.textContent = "未保存（" + nNew + "）";
      tabSaved.textContent = "已保存（" + nSaved + "）";
      tabNew.style.cssText = tabStyle(activeTab === "new");
      tabSaved.style.cssText = tabStyle(activeTab === "saved");
    }
    tabNew.addEventListener("click", function () { activeTab = "new"; refreshTabs(); buildRows(); });
    tabSaved.addEventListener("click", function () { activeTab = "saved"; refreshTabs(); buildRows(); });
    tabBar.appendChild(tabNew);
    tabBar.appendChild(tabSaved);

    var list = el("div", "flex:1;overflow-y:auto;padding:4px 12px");
    var rows = {};
    function buildRows() {
      list.innerHTML = "";
      rows = {};
      var q = (search.value || "").trim().toLowerCase();
      var match = function (m) { return !q || m.id.toLowerCase().indexOf(q) >= 0; };
      var badge = function (text, bg) {
        return el("span", "font-size:11px;padding:2px 6px;border-radius:6px;background:" + bg, text);
      };
      var empty = el("div", "padding:4px 8px;font-size:12px;opacity:.5", "（无）");
      var shown = 0;
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (!match(m)) continue;
        // NOTE: const (not var) — with var every row's change listener would
        // close over the LAST iteration's cb/st/row and all checkbox clicks
        // would silently be no-ops ("saved 0" / "uncheck ignored").
        const st = state[m.id];
        const inTab = activeTab === "saved" ? st.savedVisible : !st.savedVisible;
        if (!inTab) continue;
        shown++;
        const row = el("label", "display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = st.selected;
        cb.addEventListener("click", function (e) {
          e.stopPropagation();
        });
        cb.addEventListener("change", function () {
          st.selected = cb.checked;
          row.style.background = st.selected ? (dark ? "rgba(96,165,250,.08)" : "rgba(96,165,250,.06)") : (activeTab === "saved" ? "rgba(192,57,43,.08)" : "transparent");
          refreshTabs();
          updateCounts();
        });
        const name = el("span", "font-family:ui-monospace,monospace;flex:1;word-break:break-all", m.id);
        row.appendChild(cb);
        row.appendChild(name);
        if (st.probing) row.appendChild(el("span", "font-size:11px;opacity:.7", "探测中…"));
        else if (st.visionProbed) row.appendChild(badge(st.vision ? "视觉 ✓" : "无视觉", st.vision ? "rgba(34,197,94,.18)" : "rgba(120,120,120,.18)"));
        else if (st.vision) row.appendChild(badge("疑似视觉", "rgba(34,197,94,.12)"));
        if (activeTab === "saved") {
          row.style.background = st.selected ? (dark ? "rgba(96,165,250,.08)" : "rgba(96,165,250,.06)") : "rgba(192,57,43,.08)";
          row.appendChild(badge(st.selected ? "保留" : "将删除", st.selected ? "rgba(120,120,120,.15)" : "rgba(192,57,43,.18)"));
        } else {
          row.appendChild(badge(st.wasHidden ? "已隐藏" : "新模型", st.wasHidden ? "rgba(120,120,120,.15)" : "rgba(96,165,250,.15)"));
        }
        list.appendChild(row);
        rows[m.id] = { row: row, cb: cb };
      }
      if (!shown) list.appendChild(empty);
    }
    function setAll(mode) {
      for (var i = 0; i < models.length; i++) {
        const st = state[models[i].id];
        const inTab = activeTab === "saved" ? st.savedVisible : !st.savedVisible;
        if (!inTab) continue;
        st.selected = mode === true;
      }
      buildRows();
      refreshTabs();
      updateCounts();
    }
    function probeChecked() {
      var ids = [];
      for (var i = 0; i < models.length; i++) {
        const st = state[models[i].id];
        if (!st.savedVisible && st.selected) ids.push(models[i].id);
      }
      if (!ids.length) return toast("先在「未保存」页勾选要探测的模型", false);
      if (!creds.baseUrl) return toast("缺少 Base URL", false);
      var idx = 0;
      probeBtn.disabled = true;
      function next() {
        if (idx >= ids.length) {
          probeBtn.disabled = false;
          buildRows();
          return toast("视觉探测完成");
        }
        var id = ids[idx++];
        state[id].probing = true;
        buildRows();
        Promise.resolve(api().probeVision(creds.baseUrl, creds.apiKey, id, {})).then(function (r) {
          state[id].probing = false;
          if (r && r.ok) {
            state[id].vision = !!r.vision;
            state[id].visionProbed = true;
          }
          next();
        });
      }
      next();
    }
    search.addEventListener("input", buildRows);

    var footer = el("div", "display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid " + (dark ? "#333" : "#eee"));
    var countLabel = el("div", "font-size:12px;opacity:.8", "");
    var actions = el("div", "display:flex;gap:8px");
    actions.appendChild(toolBtn("取消", function () { overlay.remove(); }));
    var confirm = el("button", "padding:7px 16px;border-radius:8px;cursor:pointer;border:none;color:#fff;font-size:13px;background:#2d6cdf", "确认保存");
    actions.appendChild(confirm);
    footer.appendChild(countLabel);
    footer.appendChild(actions);
    function updateCounts() {
      var add = 0;
      var newTotal = 0;
      var del = 0;
      var savedTotal = 0;
      for (var k in state) {
        if (state[k].savedVisible) {
          savedTotal++;
          if (!state[k].selected) del++;
        } else {
          newTotal++;
          if (state[k].selected) add++;
        }
      }
      countLabel.textContent = "将添加 " + add + " / " + newTotal + "；将删除 " + del + " / " + savedTotal;
    }

    confirm.addEventListener("click", function () {
      // visible checkboxes are the source of truth (belt & braces on top of
      // the per-row change listeners); the inactive tab keeps its state
      for (var v in rows) {
        try { state[v].selected = !!rows[v].cb.checked; } catch (e) {}
      }
      var selected = [];
      var addCount = 0;
      var delCount = 0;
      for (var i = 0; i < models.length; i++) {
        const st = state[models[i].id];
        if (st.selected) selected.push(models[i].id);
        if (st.savedVisible && !st.selected) delCount++;
        if (!st.savedVisible && st.selected) addCount++;
      }
      confirm.disabled = true;
      confirm.textContent = "⏳ 正在保存…";
      readConfig()
        .then(function (cfg) {
          var hit = resolveProviderHit(cfg, creds.baseUrl, templates);
          if (!hit) throw new Error("config 中找不到 baseURL 匹配的供应商，请先保存该供应商");
          var providerKey = hit.format === "rules" ? ruleProviderId(hit.rule) : String(hit.key);
          var fetched = models.map(function (m) {
            return { id: m.id, visionGuess: state[m.id].vision };
          });
          return readDeletedSet(providerKey).then(function (deleted) {
            mergeFinalState(cfg, hit, fetched, selected, deleted);
            return Promise.all([writeConfig(cfg), writeDeletedSet(providerKey, deleted)]).then(function () {
              overlay.remove();
              var pname = hit.format === "rules" ? ruleName(hit.rule) : (hit.p.name || hit.key);
              toast("已保存到 " + pname + "：新增 " + addCount + " 个，删除 " + delCount + " 个", true);
              triggerRefresh(pname);
            });
          });
        })
        .catch(function (e) {
          confirm.disabled = false;
          confirm.textContent = "确认保存";
          toast((e && e.message) || "保存失败", false);
        });
    });

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(tabBar);
    panel.appendChild(list);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    refreshTabs();
    buildRows();
    updateCounts();
  }

  // final-state merge, mirroring src/config.mjs semantics.
  // Checked models: unsaved ones get added — membership (personalModelIds) +
  // ordering (modelOrder) — and any manual override is REMOVED so the model
  // keeps using ZCode's intelligent configuration; already-saved ones stay
  // (re-checking a hidden template model re-enables it). Unchecked
  // models that are currently SAVED get deleted: personal models are fully
  // removed (personalModelIds + modelOrder + any exact rule, mirroring the
  // app's deletePersonalModel), and template built-ins are hidden via an
  // enabled:false provider-model rule (the template universe always contains
  // them — deletion means disabled).
  // Unchecked models that are not saved only get a tombstone so auto-sync
  // won't force them in later. Tombstones live in the tool state file (the
  // `deleted` set is mutated in place and persisted by the caller) — never
  // inside provider_config.json, whose strict schema rejects unknown keys.
  function mergeFinalState(cfg, hit, fetched, selected, deleted) {
    var want = {};
    for (var i = 0; i < selected.length; i++) want[String(selected[i])] = 1;

    if (hit.format === "rules") {
      var rule = hit.rule;
      if (!rule.config || typeof rule.config !== "object") rule.config = {};
      var c = rule.config;
      var providerId = ruleProviderId(rule);
      var order = Array.isArray(c.modelOrder) ? c.modelOrder.map(String) : [];
      var personal = Array.isArray(c.personalModelIds) ? c.personalModelIds.map(String) : [];
      var builtin = {};
      if (Array.isArray(c.builtinModelIds)) {
        for (var bi = 0; bi < c.builtinModelIds.length; bi++) builtin[String(c.builtinModelIds[bi])] = 1;
      }
      // template models are defined by the template itself — never duplicate
      // them into personalModelIds, and "deleting" them means disabling
      if (hit.template && Array.isArray(hit.template.builtinModelIds)) {
        for (var ti = 0; ti < hit.template.builtinModelIds.length; ti++) builtin[String(hit.template.builtinModelIds[ti])] = 1;
      }
      // snapshot of what is currently VISIBLE (BEFORE any mutation):
      // in the universe and not disabled by an enabled:false rule
      var savedVisible = {};
      var wasPersonal = {};
      for (var oi = 0; oi < order.length; oi++) savedVisible[order[oi]] = 1;
      for (var pi = 0; pi < personal.length; pi++) {
        savedVisible[personal[pi]] = 1;
        wasPersonal[personal[pi]] = 1;
      }
      for (var bk in builtin) savedVisible[bk] = 1;
      var mcr = modelConfigRulesOf(cfg);
      var disabledByRule = {};
      if (mcr) {
        var ruleLists = [mcr.manualProviderModelRules, mcr.providerModelRules];
        for (var rl2 = 0; rl2 < ruleLists.length; rl2++) {
          var rl3 = ruleLists[rl2];
          for (var di = 0; di < rl3.length; di++) {
            var dr = rl3[di];
            if (dr && typeof dr === "object" && String(dr.providerId) === providerId &&
                dr.config && typeof dr.config === "object" && dr.config.enabled === false) {
              disabledByRule[String(dr.modelId)] = 1;
              delete savedVisible[String(dr.modelId)];
            }
          }
        }
      }

      for (var a = 0; a < fetched.length; a++) {
        var f = fetched[a];
        var fid = String(f.id);
        if (want[fid]) {
          // checked: add / keep / re-enable
          delete deleted[fid];
          if (order.indexOf(fid) < 0) order.push(fid);
          if (!builtin[fid] && personal.indexOf(fid) < 0) personal.push(fid);
          if (!mcr) continue;
          // Intelligent configuration: remove any exact manual override so
          // ZCode uses its builtin modelRules/providerSiteRules recommendation.
          enableSmartConfigOf(mcr, providerId, fid);
          // re-adding must also clear a hide rule (e.g. a template built-in
          // deleted earlier), otherwise the model stays disabled
          var hideRule = findSmartRuleOf(mcr, providerId, fid);
          if (hideRule && hideRule.config && hideRule.config.enabled === false) {
            enableModelOf(mcr, providerId, fid);
          }
        } else if (savedVisible[fid]) {
          // unchecked AND currently saved -> explicit delete
          deleted[fid] = 1;
          if (personal.indexOf(fid) >= 0) {
            personal = personal.filter(function (x) { return x !== fid; });
            if (mcr) {
              dropManualRuleOf(mcr, providerId, fid);
              unhideModelOf(mcr, providerId, fid);
            }
          }
          order = order.filter(function (x) { return x !== fid; });
          if (builtin[fid] && !wasPersonal[fid] && mcr) {
            // template built-in: hide it instead of removing (universe is
            // fixed) — same provider-model rule ZCode's own toggle writes
            hideModelOf(mcr, providerId, fid);
          }
        } else {
          // unchecked and not saved: tombstone only, nothing is removed
          deleted[fid] = 1;
        }
      }

      c.modelOrder = order;
      c.personalModelIds = personal;
      return;
    }

    // legacy config.json provider.models format — same final-state semantics
    var p = hit.p;
    if (!p.models || typeof p.models !== "object" || Array.isArray(p.models)) p.models = {};
    for (var b = 0; b < fetched.length; b++) {
      var g = fetched[b];
      var gid = String(g.id);
      if (want[gid]) {
        delete deleted[gid];
        if (!p.models[gid]) {
          p.models[gid] = {
            name: gid,
            limit: { context: 128000, output: 8192 },
            modalities: { input: g.visionGuess ? ["text", "image"] : ["text"], output: ["text"] },
          };
        }
      } else if (p.models[gid]) {
        delete p.models[gid];
        deleted[gid] = 1;
      } else {
        deleted[gid] = 1;
      }
    }
  }

  // modelConfigRules helpers (renderer copies of src/config.mjs)
  function modelConfigRulesOf(cfg) {
    var c = cfg && cfg.config && typeof cfg.config === "object" ? cfg.config : null;
    if (!c) return null;
    if (!c.modelConfigRules || typeof c.modelConfigRules !== "object" || Array.isArray(c.modelConfigRules)) {
      c.modelConfigRules = { providerModelRules: [], manualProviderModelRules: [] };
    }
    var m = c.modelConfigRules;
    if (!Array.isArray(m.providerModelRules)) m.providerModelRules = [];
    if (!Array.isArray(m.manualProviderModelRules)) m.manualProviderModelRules = [];
    return m;
  }
  function dropManualRuleOf(mcr, providerId, modelId) {
    mcr.manualProviderModelRules = mcr.manualProviderModelRules.filter(function (r) {
      return !(r && typeof r === "object" && String(r.providerId) === providerId && String(r.modelId) === modelId);
    });
  }
  function enableSmartConfigOf(mcr, providerId, modelId) {
    // No manual-provider-model rule = ZCode uses intelligent/recommended
    // model configuration from its builtin model/provider-site rules.
    if (mcr) dropManualRuleOf(mcr, providerId, modelId);
  }
  // A provider-model rule with enabled === false hides a model — the same
  // shape ZCode's own enable/disable toggle writes, and the only way to
  // "delete" a template built-in (its universe always contains it).
  function findSmartRuleOf(mcr, providerId, modelId) {
    for (var i = 0; i < mcr.providerModelRules.length; i++) {
      var r = mcr.providerModelRules[i];
      if (r && typeof r === "object" && String(r.providerId) === providerId && String(r.modelId) === modelId) return r;
    }
    return null;
  }
  function hideModelOf(mcr, providerId, modelId) {
    var existing = findSmartRuleOf(mcr, providerId, modelId);
    if (existing) {
      var cfg2 = existing.config && typeof existing.config === "object" ? existing.config : {};
      existing.config = {};
      for (var k in cfg2) existing.config[k] = cfg2[k];
      existing.config.enabled = false;
      return;
    }
    mcr.providerModelRules.push({ providerId: String(providerId), modelId: String(modelId), config: { enabled: false } });
  }
  function unhideModelOf(mcr, providerId, modelId) {
    mcr.providerModelRules = mcr.providerModelRules.filter(function (r) {
      return !(r && typeof r === "object" && String(r.providerId) === providerId && String(r.modelId) === modelId);
    });
  }
  // Re-enabling keeps whatever else the rule carries (an app-written
  // contextWindow, for instance) — the same {enabled: true} shape ZCode's own
  // enable/disable toggle writes. No rule at all needs nothing: the builtin
  // catch-all already enables the model.
  function enableModelOf(mcr, providerId, modelId) {
    var existing = findSmartRuleOf(mcr, providerId, modelId);
    if (!existing) return;
    var cfg3 = existing.config && typeof existing.config === "object" ? existing.config : {};
    existing.config = {};
    for (var k2 in cfg3) existing.config[k2] = cfg3[k2];
    existing.config.enabled = true;
  }

  function triggerRefresh(providerName) {
    try {
      // heuristic 1: official refresh control by text
      var els = document.querySelectorAll("p, span, div, button, a");
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || "").trim();
        if ((t === "刷新" || t === "Refresh" || t === "重新加载") && els[i].closest("button,a,[role=button]")) {
          var target = els[i].closest("button,a,[role=button]");
          target.click();
          return;
        }
      }
      // heuristic 2: click the matching provider entry in the sidebar
      if (providerName) {
        for (var j = 0; j < els.length; j++) {
          if ((els[j].textContent || "").trim() === providerName) {
            els[j].click();
            return;
          }
        }
      }
    } catch (e) {}
  }

  // ---- pull flow ----
  function onPullClick(btn) {
    if (!api()) {
      toast("zcodeModelHub 桥不可用：preload 未注入或需重启 ZCode", false);
      return;
    }
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ 正在拉取…";
    var creds = scanFormCredentials();
    var ready = creds.baseUrl
      ? Promise.resolve(creds)
      : readConfig().then(function (cfg) {
          // fallback: exactly one provider with a baseUrl -> use it
          var rules = providerRulesOf(cfg).filter(function (r) {
            return r && typeof r === "object" && ruleBaseUrl(r);
          });
          if (rules.length === 1) {
            return { baseUrl: ruleBaseUrl(rules[0]), apiKey: ruleApiKey(rules[0]) };
          }
          var sec = cfg.provider || {};
          var keys = Array.isArray(sec) ? sec.map(function (_, i) { return i; }) : Object.keys(sec);
          if (keys.length === 1) {
            var p = Array.isArray(sec) ? sec[0] : sec[keys[0]];
            return { baseUrl: (p.options && p.options.baseURL) || p.baseURL || "", apiKey: (p.options && p.options.apiKey) || p.apiKey || "" };
          }
          throw new Error("页面上没有识别到 Base URL，请先填写并保存供应商信息");
        });
    ready
      .then(function (c) {
        if (!c.baseUrl) throw new Error("缺少 Base URL");
        return Promise.resolve(api().fetchModels(c.baseUrl, c.apiKey, { dialect: "auto" })).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || "拉取失败，请检查 Base URL 和 API Key");
          creds = c;
          // per-provider saved/hidden sets from the matched provider rule
          // (with template fallback); fall back to a DOM scan only when the
          // rule cannot be matched
          return Promise.all([readConfig(), readTemplates()]).then(function (rs) {
            var cfg = rs[0];
            var templates = rs[1];
            var hit = resolveProviderHit(cfg, creds.baseUrl, templates);
            var sets = hit && hit.format === "rules" ? savedHiddenSets(cfg, hit) : null;
            if (!sets) {
              var domIds = existingModelIdsFromDom();
              sets = { visible: domIds, hidden: {} };
            }
            openModal(r, c, sets, templates);
          });
        });
      })
      .catch(function (e) {
        toast((e && e.message) || "拉取失败", false);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  // ---- boot ----
  function boot() {
    checkAndInject();
    new MutationObserver(function () {
      checkAndInject();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
