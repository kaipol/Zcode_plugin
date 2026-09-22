/* __ZCODE_MODEL_HUB_V1__ main-process handlers (appended block).
 * Self-contained; safe to remove this whole block to uninstall.
 * Registers: modelhub:read-config / write-config / read-state / write-state /
 * fetch-models / probe-vision. Config target: ~/.zcode/v2/provider_config.json
 * (falls back to config.json on pre-3.x builds).
 */
;(async () => {
  try {
    const G = globalThis;
    if (G.__ZCODE_MODEL_HUB_V1_MAIN__) return;
    G.__ZCODE_MODEL_HUB_V1_MAIN__ = true;
    const electron = await import("electron");
    const fs = (await import("node:fs")).default;
    const path = (await import("node:path")).default;
    const os = (await import("node:os")).default;
    const https = (await import("node:https")).default;
    const http = (await import("node:http")).default;

    // Latest ZCode (3.x) keeps the personal provider config at
    // provider_config.json (strict schema: only schemaVersion + config at the
    // root). Older builds used config.json — kept as a read/write fallback.
    const V2_DIR = path.join(os.homedir(), ".zcode", "v2");
    const CONFIG_CANDIDATES = [path.join(V2_DIR, "provider_config.json"), path.join(V2_DIR, "config.json")];
    const STATE_PATH = path.join(os.homedir(), ".zcode", "model-hub", "state.json");
    const PNG_1PX =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const VISION_RE =
      /(4o|4\.1|omni|vision|vl-|-vl|glm-4v|glm-5v|gemini|claude-[3-9]|pixtral|llava|internvl|gpt-5)/i;

    function normBase(u) {
      return String(u || "").trim().replace(/\/+$/, "");
    }
    function guessDialect(u) {
      const b = normBase(u).toLowerCase();
      if (b.includes("anthropic") || b.includes("claude")) return "anthropic";
      if (b.includes("generativelanguage") || b.includes("googleapis")) return "gemini";
      return "openai";
    }
    function candidatesFor(dialect, base) {
      const endsV1 = /\/v1$/.test(base);
      if (dialect === "anthropic") return [endsV1 ? base + "/models" : base + "/v1/models"];
      if (dialect === "gemini") {
        const root = base.replace(/\/v1(beta)?$/, "");
        return [root + "/v1beta/models"];
      }
      const cands = [];
      if (endsV1) {
        cands.push(base + "/models");
        cands.push(base.replace(/\/v1$/, "") + "/models");
      } else {
        cands.push(base + "/v1/models");
        cands.push(base + "/models");
      }
      if (/\/api$/.test(base)) cands.unshift(base + "/v1/models");
      return [...new Set(cands)];
    }
    function authHeaders(dialect, key, extra) {
      const h = { Accept: "application/json", ...(extra || {}) };
      if (dialect === "anthropic") {
        if (key) {
          h["x-api-key"] = key.trim();
          h["Authorization"] = "Bearer " + key.trim();
        }
        h["anthropic-version"] = h["anthropic-version"] || "2023-06-01";
      } else if (dialect === "gemini") {
        if (key) h["x-goog-api-key"] = key.trim();
      } else if (key) {
        h["Authorization"] = "Bearer " + key.trim();
      }
      return h;
    }
    function httpRequest(url, options) {
      const { headers = {}, method = "GET", body = null, timeout = 10000, redirects = 3 } = options || {};
      return new Promise((resolve, reject) => {
        let u;
        try {
          u = new URL(url);
        } catch (e) {
          return reject(new Error("bad url"));
        }
        if (u.protocol !== "http:" && u.protocol !== "https:")
          return reject(new Error("unsupported protocol"));
        const mod = u.protocol === "http:" ? http : https;
        const req = mod.request(u, { method, headers, timeout }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return resolve(httpRequest(new URL(res.headers.location, u).toString(), { headers, method, body, timeout, redirects: redirects - 1 }));
          }
          const chunks = [];
          let len = 0;
          res.on("data", (c) => {
            len += c.length;
            if (len > 8 * 1024 * 1024) {
              req.destroy();
              reject(new Error("response too large"));
            } else chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    }
    function parseModels(json) {
      const out = [];
      const list = Array.isArray(json)
        ? json
        : Array.isArray(json && json.data)
          ? json.data
          : Array.isArray(json && json.models)
            ? json.models
            : [];
      for (const it of list) {
        const id = typeof it === "string" ? it.trim() : String((it && (it.id || it.name)) || "").trim();
        if (id) out.push(id.replace(/^models\//, ""));
      }
      return [...new Set(out)].sort().map((id) => ({ id, visionGuess: VISION_RE.test(id) }));
    }
    function redact(u) {
      return String(u).replace(/([?&])key=[^&]*/g, "$1key=***");
    }
    async function fetchModels({ baseUrl, apiKey, headers, dialect }) {
      const base = normBase(baseUrl);
      if (!base) return { ok: false, error: "empty baseUrl" };
      const dialects = dialect === "auto" || !dialect ? ["openai", "anthropic", "gemini"] : [dialect];
      const errors = [];
      for (const d of dialects) {
        for (const url of candidatesFor(d, base)) {
          const target =
            d === "gemini" && apiKey && !url.includes("key=")
              ? url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(apiKey.trim())
              : url;
          try {
            const res = await httpRequest(target, { headers: authHeaders(d, apiKey, headers) });
            if (res.status < 200 || res.status >= 300) {
              errors.push(d + " " + redact(target) + " -> HTTP " + res.status);
              continue;
            }
            const models = parseModels(JSON.parse(res.body));
            if (models.length) return { ok: true, dialect: d, models };
            errors.push(d + " " + redact(target) + " -> 0 models");
          } catch (e) {
            errors.push(d + " " + redact(target) + " -> " + (e && e.message));
          }
        }
      }
      return { ok: false, error: errors.join("; ") };
    }
    async function probeVision({ baseUrl, apiKey, model, headers, dialect }) {
      const base = normBase(baseUrl);
      const attempts = dialect === "auto" || !dialect ? ["openai", "anthropic"] : [dialect];
      let lastErr = "no endpoint accepted the probe";
      for (const d of attempts) {
        const root = /\/v1$/.test(base) ? base : base + "/v1";
        const url = d === "anthropic" ? root + "/messages" : root + "/chat/completions";
        const content =
          d === "anthropic"
            ? [
                { type: "text", text: "Reply with one word: OK" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } },
              ]
            : [
                { type: "text", text: "Reply with one word: OK" },
                { type: "image_url", image_url: { url: "data:image/png;base64," + PNG_1PX } },
              ];
        const body = { model, max_tokens: 10, messages: [{ role: "user", content }] };
        try {
          const res = await httpRequest(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders(d, apiKey, headers) },
            body: JSON.stringify(body),
            timeout: 15000,
          });
          if (res.status >= 200 && res.status < 300) return { ok: true, vision: true, dialect: d };
          if (res.status === 400 && /image|multimodal|vision|modalit/i.test(res.body))
            return { ok: true, vision: false, dialect: d, detail: "rejected image input" };
          if (res.status === 404) continue;
          lastErr = "HTTP " + res.status + ": " + res.body.slice(0, 200);
        } catch (e) {
          lastErr = (e && e.message) || String(e);
        }
      }
      return { ok: false, error: lastErr };
    }
    function resolveConfigPath() {
      for (var i = 0; i < CONFIG_CANDIDATES.length; i++) {
        try {
          if (fs.existsSync(CONFIG_CANDIDATES[i])) return CONFIG_CANDIDATES[i];
        } catch {}
      }
      return CONFIG_CANDIDATES[0];
    }
    // One-time conversion to intelligent configuration: plugin versions before
    // smart config wrote a full manual-provider-model rule per added model, and
    // each such rule switches that model OFF the app's builtin recommendation.
    // Rules this plugin generated (default shape, never tuned by the user) are
    // converted — an enabled:false one becomes the equivalent provider-model
    // hide rule, the rest are dropped; anything carrying real tuning is kept.
    // Mirrors migrateSmartConfig() in src/config.mjs.
    function modelRulesOf(cfg) {
      const c = cfg && cfg.config && typeof cfg.config === "object" ? cfg.config : null;
      if (!c) return null;
      if (!c.modelConfigRules || typeof c.modelConfigRules !== "object" || Array.isArray(c.modelConfigRules)) {
        c.modelConfigRules = { providerModelRules: [], manualProviderModelRules: [] };
      }
      const m = c.modelConfigRules;
      if (!Array.isArray(m.providerModelRules)) m.providerModelRules = [];
      if (!Array.isArray(m.manualProviderModelRules)) m.manualProviderModelRules = [];
      return m;
    }
    function onlyKeys(v, allowed) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const keys = Object.keys(v);
      return keys.length > 0 && keys.every(k => allowed.indexOf(k) >= 0);
    }
    function looksPluginGenerated(config) {
      if (!onlyKeys(config, ["enabled", "properties", "optionSpecs"])) return false;
      if (typeof config.enabled !== "boolean") return false;
      const p = config.properties;
      if (!onlyKeys(p, ["contextWindow", "supportsJsonSchemaOutput", "supportsNativeWebSearch", "supportsMidConversationSystem", "inputFormat"])) return false;
      if (!Number.isInteger(p.contextWindow) || p.contextWindow <= 0) return false;
      if (p.supportsJsonSchemaOutput === true || p.supportsNativeWebSearch === true || p.supportsMidConversationSystem === true) return false;
      const input = p.inputFormat;
      if (!onlyKeys(input, ["supportsImage", "supportsVideo", "supportsPdf"])) return false;
      if (input.supportsVideo === true || input.supportsPdf === true) return false;
      const o = config.optionSpecs;
      if (!onlyKeys(o, ["reasoningLevel", "maxOutputTokens"])) return false;
      const rl = o.reasoningLevel;
      if (!onlyKeys(rl, ["values", "map"])) return false;
      if (!Array.isArray(rl.values) || rl.values.length !== 2 || rl.values[0] !== "disabled" || rl.values[1] !== "enabled") return false;
      if (typeof rl.map !== "string" || rl.map.replace(/\s+/g, "") !== "{}") return false;
      const mot = o.maxOutputTokens;
      if (!onlyKeys(mot, ["max"])) return false;
      return Number.isInteger(mot.max) && mot.max > 0;
    }
    function migrateSmartConfig(cfg) {
      if (!cfg || typeof cfg !== "object" || !cfg.config || typeof cfg.config !== "object") return false;
      const mcr = modelRulesOf(cfg);
      if (!mcr) return false;
      const before = mcr.manualProviderModelRules.length;
      mcr.manualProviderModelRules = mcr.manualProviderModelRules.filter(rule => {
        if (!rule || typeof rule !== "object") return false;
        if (!looksPluginGenerated(rule.config)) return true;
        const providerId = String(rule.providerId ?? "");
        const modelId = String(rule.modelId ?? "");
        // the app rejects a config that declares both rule kinds for the same
        // provider/model — an existing provider-model rule wins, drop ours
        if (mcr.providerModelRules.some(r => r && typeof r === "object" && String(r.providerId ?? "") === providerId && String(r.modelId ?? "") === modelId)) return false;
        if (rule.config.enabled === false) {
          mcr.providerModelRules.push({ providerId: providerId, modelId: modelId, config: { enabled: false } });
        }
        return false;
      });
      return mcr.manualProviderModelRules.length !== before;
    }
    function readConfig() {
      const target = resolveConfigPath();
      const cfg = JSON.parse(fs.readFileSync(target, "utf8"));
      if (migrateSmartConfig(cfg)) {
        // persist so the app picks the converted config up on its next read
        try {
          const tmp = target + ".model-hub-tmp";
          const fd = fs.openSync(tmp, "w");
          fs.writeSync(fd, JSON.stringify(cfg, null, 2), "utf8");
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fs.renameSync(tmp, target);
        } catch {}
      }
      return cfg;
    }
    function writeConfig(cfg) {
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
        throw new Error("config root must be an object");
      // the latest app validates the config root strictly (schemaVersion +
      // config only); never persist our legacy tombstone key
      delete cfg.zcode;
      const target = resolveConfigPath();
      try {
        fs.copyFileSync(target, target + ".model-hub.bak");
      } catch {}
      const tmp = target + ".model-hub-tmp";
      const fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, JSON.stringify(cfg, null, 2), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, target);
    }
    function readState() {
      try {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      } catch {
        return {};
      }
    }
    function writeState(st) {
      if (!st || typeof st !== "object" || Array.isArray(st))
        throw new Error("state root must be an object");
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      const tmp = STATE_PATH + ".model-hub-tmp";
      const fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, JSON.stringify(st, null, 2), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, STATE_PATH);
    }
    // Template providers (e.g. openrouter) keep their api.baseUrl in the
    // builtin release file, not in the personal config — expose it so the
    // renderer can match a pulled URL back to the personal rule by templateId.
    function readBuiltinTemplates() {
      const candidates = [];
      if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)
        candidates.push(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
      try {
        if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "config", "provider", "zcode-builtin.json"));
      } catch {}
      for (const p of candidates) {
        try {
          if (!p || !fs.existsSync(p)) continue;
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          const rules = j && j.config && j.config.providerConfigRules && j.config.providerConfigRules.templateRules;
          if (!Array.isArray(rules)) continue;
          const out = [];
          for (const tpl of rules) {
            if (!tpl || typeof tpl !== "object") continue;
            const c = tpl.config && typeof tpl.config === "object" ? tpl.config : {};
            const api = c.api && typeof c.api === "object" ? c.api : {};
            const baseUrl = String(api.baseUrl || api.baseURL || "");
            if (!baseUrl) continue;
            out.push({
              templateId: String(tpl.templateId || ""),
              baseUrl,
              builtinModelIds: Array.isArray(c.builtinModelIds) ? c.builtinModelIds.map(String) : [],
            });
          }
          return out;
        } catch {}
      }
      return [];
    }
    async function register(name, fn) {
      try {
        electron.ipcMain.removeHandler(name);
      } catch {}
      electron.ipcMain.handle(name, async (_e, payload) => {
        try {
          return await fn(payload);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
    }
    await register("modelhub:read-config", async () => ({ ok: true, data: readConfig() }));
    await register("modelhub:write-config", async (cfg) => {
      writeConfig(cfg);
      return { ok: true };
    });
    await register("modelhub:read-state", async () => ({ ok: true, data: readState() }));
    await register("modelhub:write-state", async (st) => {
      writeState(st);
      return { ok: true };
    });
    await register("modelhub:read-templates", async () => ({ ok: true, data: readBuiltinTemplates() }));
    await register("modelhub:fetch-models", async (p) => fetchModels(p || {}));
    await register("modelhub:probe-vision", async (p) => probeVision(p || {}));
  } catch (e) {
    try {
      console.error("[zcode-model-hub] main init failed:", (e && e.message) || e);
    } catch {}
  }
})();
